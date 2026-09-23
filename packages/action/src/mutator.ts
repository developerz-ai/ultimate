/**
 * The `mutator` primitive: an action plus an optimistic local twin. It is built
 * on `action()`, not beside it — a mutator IS an action, so it gets the route,
 * the OpenAPI entry, the client method, the MCP tool, the job handle and the
 * contract tests for free, and its authz is the same single evaluation.
 */

import type { ConflictPolicy, Ctx, Row } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type {
  Action,
  ActionCache,
  ActionDef,
  ActionDescriptor,
  ActionMcp,
  ActionRateLimit,
  ActionRowArgs,
} from './action';
import { action, isAction } from './action';
import type { Deprecation } from './deprecation';
import { assertConflictClock } from './mutator-clock';
import type { ActionPolicy } from './policy-gate';

/**
 * Augmented by the app so `tx.posts` is typed:
 *
 * ```ts
 * declare module '@ultimat3/action' {
 *   interface LocalTables { posts: PostRow }
 * }
 * ```
 */
export interface LocalTables {
  /** Reserved marker so augmentation, not this key, defines the table set. */
  readonly '~ultimate': never;
}

export type LocalTableName = Exclude<keyof LocalTables, '~ultimate'>;

/**
 * One table as a mutator's `local` half sees it — the SAME shape as `@ultimat3/realtime`'s store tx
 * (`record-tx.ts`), so a twin typed against this runs against the page's record store unchanged.
 * Rows are addressed by KEY, never by a column: the browser holds no entity schema and cannot know
 * a primary key, so an optimistic insert names the key its server twin will answer under.
 */
export interface LocalTable<TRow extends object = Row> {
  get(key: string): TRow | undefined;
  all(): readonly TRow[];
  insert(key: string, row: TRow): void;
  /** Merged over what the table holds; an `undefined` field leaves the column alone. */
  upsert(key: string, row: TRow): void;
  /** Changed fields only — or a function returning them. A no-op for a key the table does not hold. */
  update(key: string, patch: Partial<TRow> | ((row: TRow) => Partial<TRow>)): void;
  delete(key: string): void;
}

/**
 * The client-side write surface a mutator's `local()` gets. `@ultimat3/realtime` implements it over
 * the page's record store; tests implement it over a Map.
 */
export type LocalTx = {
  readonly [K in LocalTableName]: LocalTable<Extract<LocalTables[K], object>>;
} & {
  /** Escape hatch for generated code that only knows the table name as a string. */
  table<TRow extends object = Row>(name: string): LocalTable<TRow>;
};

/**
 * `conflict: custom(merge)` — core's row-shaped `ConflictPolicy`, built. `merge` receives the local
 * ROW and the server ROW, because the client store is row-shaped: the output-shaped variant this
 * replaced was dropped silently by realtime's rebase, which only ever had rows to hand it.
 *
 * `TRow` is the app's declared row shape, a caller-side annotation only — at rebase the resolver
 * hands over whatever the store holds for that record, which is the entity's row.
 */
export function custom<TRow extends object = Row>(
  merge: (local: TRow, server: TRow) => TRow,
): ConflictPolicy {
  // The one widening in the vocabulary: core's policy is over `Row`, the app's merge over its row.
  return { kind: 'custom', merge: merge as unknown as (local: Row, server: Row) => Row };
}

export interface MutatorDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  TRow = unknown,
> {
  readonly input: TInput;
  readonly output: TOutput;
  readonly policy: ActionPolicy<TRow>;
  readonly cache?: ActionCache;
  readonly mcp?: ActionMcp;
  /** Same key, same meaning as an action's — a mutator IS an action. */
  readonly rateLimit?: ActionRateLimit;
  /** Same key, same meaning as an action's: `Deprecation`/`Sunset` on every response. */
  readonly deprecated?: Deprecation;
  readonly idempotent?: boolean;
  /**
   * The row a row-level `policy` decides about — an action's `row`, and dropped on the way into
   * the action until 2026-09-23, so such a policy received `row === null` and denied every call.
   */
  row?(args: ActionRowArgs<TInput>): TRow | null | Promise<TRow | null>;
  /**
   * Record every attempt through the installed `AuditSink`. Same key, same meaning as an
   * action's — a mutator IS an action, so it inherits the seam rather than getting a second one.
   * `.local()` is the one half nothing records: it never leaves the client, so there is no
   * server-authoritative attempt to attest to.
   */
  readonly audit?: boolean;
  /** Optimistic twin: runs against the local store, synchronously, no I/O. */
  local(tx: LocalTx, input: InferOutput<TInput>): void;
  /** Authoritative write. Identical to an action `handle`, ctx-first for symmetry. */
  server(
    ctx: Ctx,
    input: InferOutput<TInput>,
  ): Promise<InferOutput<TOutput>> | InferOutput<TOutput>;
  readonly conflict: ConflictPolicy;
}

export type MutatorDescriptor = Omit<ActionDescriptor, 'kind'> & {
  readonly kind: 'mutator';
  readonly conflict: 'server-wins' | 'last-write-wins' | 'custom';
};

export interface Mutator<
  TInput extends StandardSchemaV1 = StandardSchemaV1,
  TOutput extends StandardSchemaV1 = StandardSchemaV1,
> extends Action<TInput, TOutput> {
  /**
   * The brand, and the only thing `describeAction` has to go on: it reads this field to set
   * `ActionDescriptor.mutator`, because a mutator's `describe()` still reports `kind: 'action'`.
   * Renaming it here would silently turn every mutator back into a plain action downstream.
   */
  readonly isMutator: true;
  readonly conflict: ConflictPolicy;
  /**
   * Applied on the client before the server round trip, and replayed on every
   * rebase — so it must stay a pure function of `(tx, input)`: no I/O, no clock,
   * no randomness. Takes parsed input because nothing re-parses on this half.
   */
  local(tx: LocalTx, input: InferOutput<TInput>): void;
  /**
   * The authoritative half. Routes through the action's own callable, never the
   * declared `server` — so input parsing, policy, the handler and output parsing
   * run exactly once, in the one core, the same as every other surface. Takes raw
   * input, like the callable and `.as()`, because this is where parsing happens.
   */
  server(ctx: Ctx, input: InferInput<TInput>): Promise<InferOutput<TOutput>>;
  describeMutator(): MutatorDescriptor;
  named(name: string): Mutator<TInput, TOutput>;
}

export function mutator<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  TRow = unknown,
>(def: MutatorDef<TInput, TOutput, TRow>): Mutator<TInput, TOutput> {
  const row = def.row;
  const actionDef: ActionDef<TInput, TOutput, TRow> = {
    input: def.input,
    output: def.output,
    policy: def.policy,
    ...(def.cache === undefined ? {} : { cache: def.cache }),
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    ...(def.rateLimit === undefined ? {} : { rateLimit: def.rateLimit }),
    ...(def.deprecated === undefined ? {} : { deprecated: def.deprecated }),
    ...(row === undefined ? {} : { row: (args: ActionRowArgs<TInput>) => row.call(def, args) }),
    ...(def.idempotent === undefined ? {} : { idempotent: def.idempotent }),
    ...(def.audit === undefined ? {} : { audit: def.audit }),
    handle: ({ input, ctx }) => def.server(ctx, input),
  };
  // Before the action is built: a policy that cannot do what it says is refused at declaration.
  if (def.conflict === 'last-write-wins') assertConflictClock(def.output);
  return wrap(def, action(actionDef));
}

/**
 * Structural, exactly like `isAction`: the brand alone is not enough, because a
 * mutator's authoritative half runs through the action's declaration and a
 * look-alike has none. Branding without `isAction` would have made this the one
 * primitive whose façade a hand-rolled object could counterfeit.
 */
export function isMutator(value: unknown): value is Mutator {
  return isAction(value) && (value as { isMutator?: unknown }).isMutator === true;
}

function wrap<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  def: MutatorDef<TInput, TOutput>,
  base: Action<TInput, TOutput>,
): Mutator<TInput, TOutput> {
  // Captured before we overwrite it: wrapping in place would otherwise make
  // `named` call itself forever instead of reaching the action's own rename.
  const rename = base.named.bind(base);
  const self: Mutator<TInput, TOutput> = Object.assign(base, {
    isMutator: true as const,
    conflict: def.conflict,
    local: (tx: LocalTx, input: InferOutput<TInput>): void => {
      def.local(tx, input);
    },
    // `base(...)` and not `def.server(...)`: the callable IS `invoke`, so the
    // authoritative half cannot skip the input parse, the policy or the output
    // parse. Calling the declaration here would be the second execution path.
    server: (ctx: Ctx, input: InferInput<TInput>): Promise<InferOutput<TOutput>> =>
      base(input, { ctx }),
    describeMutator: (): MutatorDescriptor => ({
      ...base.describe(),
      kind: 'mutator' as const,
      conflict: strategyOf(def.conflict),
    }),
    named: (name: string): Mutator<TInput, TOutput> => wrap(def, rename(name)),
  });
  return self;
}

/** The descriptor's name for a policy — the manifest and `x actions describe` print this. */
function strategyOf(conflict: ConflictPolicy): MutatorDescriptor['conflict'] {
  return typeof conflict === 'string' ? conflict : conflict.kind;
}
