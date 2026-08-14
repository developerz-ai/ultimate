/**
 * The one invocation core: parse input, evaluate policy, run the handler, parse
 * output. The declaration lives in this module's private store, so `handle` is
 * unreachable from anywhere else — HTTP, MCP, jobs and `.as()` hand `invoke` a
 * payload, and none of them can become a second execution path.
 */

import type { Ctx } from '@ultimat3/core';
import {
  anonymousActor,
  createContext,
  runWithContext,
  tryUseContext,
  useContext,
  withChildContext,
  withSpan,
} from '@ultimat3/core';
import type { AnyAction, AnyActionDef, InvokeOptions } from './action';
import { bustAfterCommit } from './cache-gate';
import { ActionForeignError, ActionUnregisteredError } from './errors';
import { getIdempotencyStore, idempotencyKeyFor, withIdempotency } from './idempotency';
import { actorOf, guard } from './policy-gate';
import { validateInput, validateOutput } from './validate';

/**
 * Private on purpose. `@ultimat3/action` exports no way to read this back, which
 * is what makes "the only way to reach `handle` is `invoke`" structural rather
 * than a rule someone has to remember.
 */
const DECLARATIONS = new WeakMap<object, AnyActionDef>();

/** Called once per built action, by `action()` and by every rename it produces. */
export function stashDef(target: object, def: AnyActionDef): void {
  DECLARATIONS.set(target, def);
}

/** True only for objects this package built — `isAction` leans on it. */
export function hasDef(target: object): boolean {
  return DECLARATIONS.has(target);
}

/** Internal read of the declaration. Never re-exported from `src/index.ts`. */
export function defOf(target: AnyAction): AnyActionDef {
  const def = DECLARATIONS.get(target);
  if (def === undefined) throw new ActionForeignError(target.name);
  return def;
}

/** Projections need a stable name; an unregistered action has none yet. */
export function actionName(target: AnyAction): string {
  if (target.name.length === 0) throw new ActionUnregisteredError();
  return target.name;
}

/**
 * Run an action. Surfaces differ only in the `surface` they pass, which selects
 * how a denial is rendered — never whether authz runs, never how input is parsed,
 * never whether the handler's return value is checked against `output`.
 */
export function invoke(
  target: AnyAction,
  raw: unknown,
  options: InvokeOptions = {},
): Promise<unknown> {
  if (options.actor === undefined) return core(target, raw, options.ctx ?? useContext(), options);

  // Impersonation keeps the surrounding context whole — services, clock, locale,
  // trace — and swaps only the actor. Policy models "nobody" as null; core models
  // it as the anonymous actor.
  const patch = { actor: options.actor ?? anonymousActor() };
  const run = (): Promise<unknown> => core(target, raw, useContext(), options);
  const base = options.ctx ?? tryUseContext();
  return base === undefined
    ? runWithContext(createContext(patch), run)
    : runWithContext(base, () => withChildContext(patch, run));
}

async function core(
  target: AnyAction,
  raw: unknown,
  ctx: Ctx,
  options: InvokeOptions,
): Promise<unknown> {
  const def = defOf(target);
  const name = actionName(target);
  const input = await validateInput(def.input, raw, name);
  // The one place a row-level rule gets its row. Once per invocation, never per row:
  // that asymmetry is what lets the predicate stay synchronous, so a live query can
  // re-evaluate the same policy per subscriber without a query per change event. An
  // action with no loader hands the rule `null` — unchanged, and never a silent allow,
  // because a rule that reads `row` has to decide what `null` means.
  const row = def.row === undefined ? null : ((await def.row({ input, ctx })) ?? null);
  guard(
    def.policy,
    { actor: actorOf(ctx), input, row, ctx, action: name },
    options.surface ?? 'server',
  );

  // Output parsing sits inside `run` so a replayed idempotent response is the
  // parsed value too — one shape on the wire, first call and every retry.
  const run = async (): Promise<unknown> => {
    const produced = await withSpan(`action.${name}`, () =>
      Promise.resolve(def.handle({ input, ctx })),
    );
    return validateOutput(def.output, produced, name);
  };

  const key = def.idempotent === true ? (options.idempotencyKey ?? null) : null;
  let value: unknown;
  let wrote = true;
  if (key === null) {
    value = await run();
  } else {
    const store = options.store ?? getIdempotencyStore();
    const outcome = await withIdempotency(store, idempotencyKeyFor(name, key), input, run);
    if (outcome.replayed) options.onReplay?.();
    wrote = !outcome.replayed;
    value = outcome.value;
  }
  // Only for a run that actually happened, and only through the gate. A replay ran no handler
  // and changed nothing the first call had not already busted — re-busting per retry re-purges
  // the CDN and re-queues ISR for a write nobody made. And the bust is post-commit either way,
  // so `bustAfterCommit` swallowing its own failure is what keeps a dead cache from turning a
  // durable write into a failed action.
  if (wrote && def.cache !== undefined) await bustAfterCommit(name, def.cache.invalidates);
  return value;
}
