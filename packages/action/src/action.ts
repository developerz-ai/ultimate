/**
 * The `action` primitive: one server-authoritative mutation, declared once.
 * Every projection in this package (route, OpenAPI, client, MCP tool, job
 * handle, contract tests) reads this declaration — none of them re-declare it.
 */

import type { CacheTag } from '@ultimat3/cache';
import { invalidateTags } from '@ultimat3/cache';
import type { Ctx } from '@ultimat3/core';
import { useContext, withSpan } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { ActionUnregisteredError } from './errors';
import {
  getIdempotencyStore,
  type IdempotencyStore,
  idempotencyKeyFor,
  withIdempotency,
} from './idempotency';
import type { JsonSchemaObject } from './json-schema';
import { jsonSchemaOf } from './json-schema';
import { derivePath, toToolName } from './naming';
import { type ActionPolicy, actorOf, guard, policyCapability, type Surface } from './policy-gate';
import { tagKeys } from './tags';
import { validateInput } from './validate';

export interface ActionCache {
  /** Tags dropped from every cache tier after the handler settles. */
  readonly invalidates: readonly CacheTag[];
}

export interface ActionMcp {
  /** Default `true`: every action is a tool unless it opts out. */
  readonly expose: boolean;
  readonly description?: string;
}

export interface ActionRateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ActionHandlerArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface ActionDef<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1> {
  readonly input: TInput;
  readonly output: TOutput;
  readonly policy: ActionPolicy;
  readonly cache?: ActionCache;
  readonly mcp?: ActionMcp;
  readonly rateLimit?: ActionRateLimit;
  /** Marks the action safe to retry with an `Idempotency-Key`. */
  readonly idempotent?: boolean;
  handle(args: ActionHandlerArgs<TInput>): Promise<InferOutput<TOutput>> | InferOutput<TOutput>;
}

export interface InvokeOptions {
  /** Explicit context. Omitted means "take the ambient request context". */
  readonly ctx?: Ctx;
  readonly surface?: Surface;
  readonly idempotencyKey?: string | null;
  readonly store?: IdempotencyStore;
  readonly onReplay?: () => void;
}

export interface McpDescriptorMeta {
  readonly expose: boolean;
  readonly tool: string;
  readonly description: string | null;
}

export interface ActionDescriptor {
  readonly kind: 'action';
  readonly name: string;
  readonly verb: string;
  readonly resource: string;
  readonly method: 'POST';
  readonly path: string;
  readonly capability: string;
  readonly input: JsonSchemaObject;
  readonly output: JsonSchemaObject;
  readonly invalidates: readonly string[];
  readonly idempotent: boolean;
  readonly mcp: McpDescriptorMeta;
  readonly rateLimit: ActionRateLimit | null;
}

/**
 * Schema-erased view of a definition. Projections that only *describe* an action
 * take this, so a concrete `Action<In, Out>` needs no variance gymnastics to be
 * passed to `toRoute`, `toMcpTool` or the registry. Members stay method-syntax on
 * purpose: bivariant parameters are what make the erasure assignable.
 */
export interface AnyActionDef {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly policy: ActionPolicy;
  readonly cache?: ActionCache;
  readonly mcp?: ActionMcp;
  readonly rateLimit?: ActionRateLimit;
  readonly idempotent?: boolean;
  handle(args: { readonly input: unknown; readonly ctx: Ctx }): unknown;
}

export interface AnyAction {
  readonly kind: 'action';
  readonly name: string;
  readonly def: AnyActionDef;
  describe(): ActionDescriptor;
  /** Returns a named twin. The registry uses this to stamp the export name. */
  named(name: string): AnyAction;
}

export interface Action<
  TInput extends StandardSchemaV1 = StandardSchemaV1,
  TOutput extends StandardSchemaV1 = StandardSchemaV1,
> extends AnyAction {
  /** Callable server-side with the same types the client and MCP tool see. */
  (input: InferInput<TInput>, opts?: InvokeOptions): Promise<InferOutput<TOutput>>;
  readonly def: ActionDef<TInput, TOutput>;
  named(name: string): Action<TInput, TOutput>;
}

export function action<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  def: ActionDef<TInput, TOutput>,
): Action<TInput, TOutput> {
  return build(def, '');
}

export function isAction(value: unknown): value is AnyAction {
  return typeof value === 'function' && (value as { kind?: unknown }).kind === 'action';
}

function build<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  def: ActionDef<TInput, TOutput>,
  name: string,
): Action<TInput, TOutput> {
  const callable = (
    input: InferInput<TInput>,
    opts: InvokeOptions = {},
  ): Promise<InferOutput<TOutput>> =>
    // `runAction` is schema-erased; the output type is this action's by construction.
    runAction(self, input, opts) as Promise<InferOutput<TOutput>>;

  const self: Action<TInput, TOutput> = Object.assign(callable, {
    kind: 'action' as const,
    def,
    describe: (): ActionDescriptor => describeAction(self),
    named: (next: string): Action<TInput, TOutput> => build(def, next),
  });
  // `name` on a function is non-writable, so Object.assign cannot set it.
  Object.defineProperty(self, 'name', { value: name, configurable: true });
  return self;
}

/**
 * The one execution path. HTTP, MCP, jobs and direct calls differ only in the
 * `surface` they pass, which selects how a denial is rendered — never whether
 * authz runs, and never how the input is validated.
 */
export async function runAction(
  target: AnyAction,
  raw: unknown,
  opts: InvokeOptions = {},
): Promise<unknown> {
  const { def } = target;
  const name = actionName(target);
  const ctx = opts.ctx ?? useContext();
  const input = await validateInput(def.input, raw, name);
  const subject = { actor: actorOf(ctx), input, ctx, action: name };
  guard(def.policy, subject, opts.surface ?? 'server');

  const run = (): Promise<unknown> =>
    withSpan(`action.${name}`, () => Promise.resolve(def.handle({ input, ctx })));

  const key = def.idempotent === true ? (opts.idempotencyKey ?? null) : null;
  let value: unknown;
  if (key === null) {
    value = await run();
  } else {
    const store = opts.store ?? getIdempotencyStore();
    const outcome = await withIdempotency(store, idempotencyKeyFor(name, key), input, run);
    if (outcome.replayed) opts.onReplay?.();
    value = outcome.value;
  }
  if (def.cache !== undefined) await invalidateTags(def.cache.invalidates);
  return value;
}

export function describeAction(target: AnyAction): ActionDescriptor {
  const name = actionName(target);
  const { def } = target;
  const path = derivePath(name);
  const mcp = def.mcp;
  return {
    kind: 'action',
    name,
    verb: path.verb,
    resource: path.resource,
    method: 'POST',
    path: path.path,
    capability: policyCapability(def.policy),
    input: jsonSchemaOf(def.input),
    output: jsonSchemaOf(def.output),
    invalidates: tagKeys(def.cache?.invalidates ?? []),
    idempotent: def.idempotent === true,
    mcp: {
      expose: mcp?.expose ?? true,
      tool: toToolName(name),
      description: mcp?.description ?? null,
    },
    rateLimit: def.rateLimit ?? null,
  };
}

/** Projections need a stable name; an unregistered action has none yet. */
export function actionName(target: AnyAction): string {
  if (target.name.length === 0) throw new ActionUnregisteredError();
  return target.name;
}
