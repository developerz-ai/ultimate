/**
 * The one invocation core: parse input, evaluate policy, run the handler, parse
 * output. The declaration lives in this module's private store, so `handle` is
 * unreachable from anywhere else — HTTP, MCP, jobs and `.as()` hand `invoke` a
 * payload, and none of them can become a second execution path.
 *
 * `audit: true` wraps that path, it never forks it: `execute` is the same body either way, and
 * the audited branch only observes it. Wrapping rather than hooking is what lets a DENIED attempt
 * be recorded at all — `guard` throws before `handle`, so nothing an app writes around its own
 * handler could ever see one.
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
import type { AuditRecord } from './audit';
import {
  auditFailureFor,
  auditOutcomeFor,
  auditSettled,
  auditSinkFor,
  auditThrew,
} from './audit-gate';
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

/**
 * What `execute` learns on the way through, for the audit record. Mutable and module-private:
 * the three facts a record needs that only exist partway down the one path, and reading them back
 * out is what keeps the audit branch from becoming a second one.
 */
interface InvokeTrace {
  input: unknown;
  idempotencyKey: string | null;
  replayed: boolean;
}

async function core(
  target: AnyAction,
  raw: unknown,
  ctx: Ctx,
  options: InvokeOptions,
): Promise<unknown> {
  const def = defOf(target);
  const name = actionName(target);
  const trace: InvokeTrace = { input: undefined, idempotencyKey: null, replayed: false };
  if (def.audit !== true) return execute(def, name, raw, ctx, options, trace);

  // Resolved before the input parse: an audited action nothing can record must refuse while it
  // has still made no change. Everything after this point has a committed write behind it.
  const sink = auditSinkFor(name);
  const draft = {
    // When the attempt began, from the context's clock — never `new Date()`.
    at: ctx.now(),
    action: name,
    // The brand `mutator()` stamps, read structurally — the same read `describeAction` makes,
    // and for the same reason: importing `isMutator` would point this module at the one that
    // imports it, for a check that needs the brand and not the predicate.
    mutator: (target as { readonly isMutator?: unknown }).isMutator === true,
    surface: options.surface ?? 'server',
    ctx,
  } as const;

  let value: unknown;
  try {
    value = await execute(def, name, raw, ctx, options, trace);
  } catch (error) {
    // A failed mutation is the record an auditor wants most, so the throw is recorded before it
    // is re-thrown — and `auditThrew` never replaces it, which is why this rethrow is
    // unconditional rather than inside an `else`.
    const record: AuditRecord = {
      ...draft,
      ...trace,
      outcome: auditOutcomeFor(error),
      failure: auditFailureFor(error),
    };
    await auditThrew(sink, record);
    throw error;
  }
  // Outside the `catch` above on purpose: an `X_AUDIT_SINK_FAILED` from here describes the
  // RECORD, not the attempt. Letting it fall into that branch wrote a second row claiming the
  // action failed, for a handler that had committed.
  await auditSettled(sink, { ...draft, ...trace, outcome: 'allowed', failure: null });
  return value;
}

async function execute(
  def: AnyActionDef,
  name: string,
  raw: unknown,
  ctx: Ctx,
  options: InvokeOptions,
  trace: InvokeTrace,
): Promise<unknown> {
  const input = await validateInput(def.input, raw, name);
  trace.input = input;
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
    // The namespaced key, not the caller's: the same key under two actions is two keys, and an
    // audit row keyed on the raw header would collide across them.
    trace.idempotencyKey = idempotencyKeyFor(name, key);
    const outcome = await withIdempotency(store, trace.idempotencyKey, input, run);
    if (outcome.replayed) options.onReplay?.();
    trace.replayed = outcome.replayed;
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
