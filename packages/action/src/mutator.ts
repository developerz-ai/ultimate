/**
 * The `mutator` primitive: an action plus an optimistic local twin. It is built
 * on `action()`, not beside it — a mutator IS an action, so it gets the route,
 * the OpenAPI entry, the client method, the MCP tool, the job handle and the
 * contract tests for free, and its authz is the same single evaluation.
 */

import type { Ctx } from '@ultimat3/core';
import { assertNever } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action, ActionCache, ActionDef, ActionDescriptor, ActionMcp } from './action';
import { action } from './action';
import type { ActionPolicy } from './policy-gate';

/** Minimum shape of a locally-stored row: an id the local twin can address. */
export interface LocalRow {
  readonly id: string;
}

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

export interface LocalTable<TRow extends LocalRow> {
  insert(row: TRow): void;
  update(id: string, patch: Partial<TRow> | ((row: TRow) => Partial<TRow>)): void;
  delete(id: string): void;
}

/**
 * The client-side write surface a mutator's `local()` gets. @ultimat3/realtime
 * implements it over OPFS SQLite; tests implement it over a Map.
 */
export type LocalTx = {
  readonly [K in LocalTableName]: LocalTable<Extract<LocalTables[K], LocalRow>>;
} & {
  /** Escape hatch for generated code that only knows the table name as a string. */
  table<TRow extends LocalRow>(name: string): LocalTable<TRow>;
};

export interface CustomConflict<TOutput> {
  readonly strategy: 'custom';
  merge(local: TOutput, server: TOutput): TOutput;
}

export type Conflict<TOutput> = 'server-wins' | 'last-write-wins' | CustomConflict<TOutput>;

export function custom<TOutput>(
  merge: (local: TOutput, server: TOutput) => TOutput,
): CustomConflict<TOutput> {
  return { strategy: 'custom', merge };
}

export interface MutatorDef<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1> {
  readonly input: TInput;
  readonly output: TOutput;
  readonly policy: ActionPolicy;
  readonly cache?: ActionCache;
  readonly mcp?: ActionMcp;
  readonly idempotent?: boolean;
  /** Optimistic twin: runs against the local store, synchronously, no I/O. */
  local(tx: LocalTx, input: InferOutput<TInput>): void;
  /** Authoritative write. Identical to an action `handle`, ctx-first for symmetry. */
  server(
    ctx: Ctx,
    input: InferOutput<TInput>,
  ): Promise<InferOutput<TOutput>> | InferOutput<TOutput>;
  readonly conflict: Conflict<InferOutput<TOutput>>;
}

export type MutatorDescriptor = Omit<ActionDescriptor, 'kind'> & {
  readonly kind: 'mutator';
  readonly conflict: 'server-wins' | 'last-write-wins' | 'custom';
};

export interface Mutator<
  TInput extends StandardSchemaV1 = StandardSchemaV1,
  TOutput extends StandardSchemaV1 = StandardSchemaV1,
> extends Action<TInput, TOutput> {
  readonly isMutator: true;
  readonly conflict: Conflict<InferOutput<TOutput>>;
  /** Applied on the client before the server round trip, and re-applied on rebase. */
  applyLocal(tx: LocalTx, input: InferOutput<TInput>): void;
  describeMutator(): MutatorDescriptor;
  named(name: string): Mutator<TInput, TOutput>;
}

export function mutator<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  def: MutatorDef<TInput, TOutput>,
): Mutator<TInput, TOutput> {
  const actionDef: ActionDef<TInput, TOutput> = {
    input: def.input,
    output: def.output,
    policy: def.policy,
    ...(def.cache === undefined ? {} : { cache: def.cache }),
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    ...(def.idempotent === undefined ? {} : { idempotent: def.idempotent }),
    handle: ({ input, ctx }) => def.server(ctx, input),
  };
  return wrap(def, action(actionDef));
}

export function isMutator(value: unknown): value is Mutator {
  return typeof value === 'function' && (value as { isMutator?: unknown }).isMutator === true;
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
    applyLocal: (tx: LocalTx, input: InferOutput<TInput>): void => {
      def.local(tx, input);
    },
    describeMutator: (): MutatorDescriptor => ({
      ...base.describe(),
      kind: 'mutator' as const,
      conflict: strategyOf(def.conflict),
    }),
    named: (name: string): Mutator<TInput, TOutput> => wrap(def, rename(name)),
  });
  return self;
}

export function strategyOf<TOutput>(
  conflict: Conflict<TOutput>,
): 'server-wins' | 'last-write-wins' | 'custom' {
  return typeof conflict === 'string' ? conflict : conflict.strategy;
}

/**
 * Rebase decision for @ultimat3/realtime: which value survives when the local
 * twin and the server disagree.
 */
export function resolveConflict<TOutput>(
  conflict: Conflict<TOutput>,
  local: TOutput,
  server: TOutput,
): TOutput {
  if (typeof conflict !== 'string') return conflict.merge(local, server);
  switch (conflict) {
    case 'server-wins':
      return server;
    case 'last-write-wins':
      return local;
    default:
      return assertNever(conflict);
  }
}
