/**
 * The `query` primitive: a policy-checked read, optionally live, declared once.
 * Row types are inferred from the `SqlSource` the `sql:` function returns, so a
 * component gets the real row shape without a second declaration. Every projection
 * in this package (live subscription, MCP tool, typed client) reads this
 * declaration through `read.ts` — none of them re-declare it.
 */

import type { CacheTag } from '@ultimat3/cache';
import type { Actor, Ctx } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { QueryClientMethod, QueryClientOptions } from './client';
import { facadeFor } from './facade';
import type { LiveQuery, ToLiveOptions } from './live';
import type { QueryToolDescriptor } from './mcp-tool';
import type { QueryPolicy, QuerySurface } from './policy-gate';
import { policyCapability } from './policy-gate';
import { hasDef, queryName, runQuery, stashDef } from './read';
import type { SqlSource } from './source';
import { fingerprint } from './stable';
import { tagKeys } from './tags';

export interface QueryCache {
  /** Tags this read depends on. An action's `invalidates` drops exactly these keys. */
  readonly tags: readonly CacheTag[];
  readonly ttlMs?: number;
}

export interface QueryMcp {
  /** Opt-in: a read reaches an agent only when it says so. Silence exposes nothing. */
  readonly expose: boolean;
  /** Contract text, not UI text — see `ActionMcp.description` for why it stays outside `t()`. */
  readonly description?: string;
}

export interface QueryDef<TInput extends StandardSchemaV1, TRow extends object> {
  readonly input: TInput;
  readonly policy: QueryPolicy;
  /** `true` makes the read subscribable — see `toLiveQuery`. */
  readonly live?: boolean;
  sql(input: InferOutput<TInput>, ctx: Ctx): SqlSource<TRow>;
  readonly cache?: QueryCache;
  readonly mcp?: QueryMcp;
}

export interface QueryOptions {
  readonly ctx?: Ctx;
  readonly surface?: QuerySurface;
  /** Skips the cache tiers for this call. Live fanout always reads fresh. */
  readonly fresh?: boolean;
  /**
   * Run as someone else. Omitted keeps the context's own actor; `null` is the
   * signed-out caller. The rest of the context is untouched, so impersonation
   * stays on the one read path instead of forking a second one.
   */
  readonly actor?: Actor | null;
}

export interface SourceOptions extends QueryOptions {
  /** `false` only for developer tooling (`explain`), which is admin-gated. */
  readonly enforce?: boolean;
}

export interface QueryDescriptor {
  readonly kind: 'query';
  readonly name: string;
  readonly live: boolean;
  readonly capability: string;
  readonly tags: readonly string[];
  readonly ttlMs: number | null;
}

/**
 * Schema-erased view of a definition, held only by `read.ts`'s private store —
 * never reachable from a query. Method syntax is load-bearing: bivariant
 * parameters are what make the erasure assignable.
 */
export interface AnyQueryDef {
  readonly input: StandardSchemaV1;
  readonly policy: QueryPolicy;
  readonly live?: boolean;
  sql(input: unknown, ctx: Ctx): SqlSource<object>;
  readonly cache?: QueryCache;
  readonly mcp?: QueryMcp;
}

export interface AnyQuery {
  readonly kind: 'query';
  readonly name: string;
  /** Declared `live: true`. The subscription itself is `live()`. */
  readonly isLive: boolean;
  /** The declaration, minus `sql`: readable, and never a way to run it. */
  readonly input: StandardSchemaV1;
  readonly policy: QueryPolicy;
  readonly cache?: QueryCache;
  readonly mcp?: QueryMcp;
  describe(): QueryDescriptor;
  /** A twin under another name. Registration names through `named`. */
  named(name: string): AnyQuery;
  /** Read as this actor. Same read path, only the context's actor changes. */
  as(actor: Actor | null, input: unknown, options?: QueryOptions): Promise<readonly object[]>;
  live(input: unknown, options?: ToLiveOptions): Promise<LiveQuery>;
  tool(): QueryToolDescriptor;
}

export interface Query<
  TInput extends StandardSchemaV1 = StandardSchemaV1,
  TRow extends object = Record<string, unknown>,
> extends AnyQuery {
  /** Callable server-side with the same types the client and the MCP tool see. */
  (input: InferInput<TInput>, options?: QueryOptions): Promise<readonly TRow[]>;
  readonly input: TInput;
  named(name: string): Query<TInput, TRow>;
  as(
    actor: Actor | null,
    input: InferInput<TInput>,
    options?: QueryOptions,
  ): Promise<readonly TRow[]>;
  live(input: InferInput<TInput>, options?: ToLiveOptions): Promise<LiveQuery>;
  /**
   * Typed against this query's input and row type, which is the whole point of it —
   * so it lives here and not on the schema-erased `AnyQuery` view.
   */
  client(options: QueryClientOptions): QueryClientMethod<TInput, TRow>;
}

/** The fluent half of a query: lifted declaration plus one method per projection. */
export type QueryFacade<TInput extends StandardSchemaV1, TRow extends object> = Pick<
  Query<TInput, TRow>,
  'input' | 'policy' | 'cache' | 'mcp' | 'as' | 'live' | 'tool' | 'client'
>;

export function query<TInput extends StandardSchemaV1, TRow extends object>(
  def: QueryDef<TInput, TRow>,
): Query<TInput, TRow> {
  return build(def, '');
}

/**
 * Structural, not nominal: an object only counts as a query if `query()` built it,
 * because only then does a declaration exist for `sourceFor` to read. A look-alike
 * with `kind: 'query'` never reaches the registry or a projection.
 */
export function isQuery(value: unknown): value is AnyQuery {
  return (
    typeof value === 'function' && (value as { kind?: unknown }).kind === 'query' && hasDef(value)
  );
}

/**
 * Stamp the export name onto the query the app declared, rather than handing back a
 * differently-named copy of it. `import { liveFeed } from './live'` is then the query
 * that projects — `liveFeed.tool()` after boot, with nothing to remember. The same
 * rule `nameAction` follows; naming twice is the one case that still needs a twin.
 */
export function nameQuery<Q extends AnyQuery>(target: Q, name: string): Q {
  if (target.name === name) return target;
  if (target.name.length > 0) return target.named(name) as Q;
  Object.defineProperty(target, 'name', { value: name, configurable: true });
  return target;
}

function build<TInput extends StandardSchemaV1, TRow extends object>(
  def: QueryDef<TInput, TRow>,
  name: string,
): Query<TInput, TRow> {
  const callable = (
    input: InferInput<TInput>,
    options: QueryOptions = {},
  ): Promise<readonly TRow[]> => runQuery(self, input, options);

  const self: Query<TInput, TRow> = Object.assign(callable, {
    kind: 'query' as const,
    isLive: def.live === true,
    describe: (): QueryDescriptor => describeQuery(self),
    named: (next: string): Query<TInput, TRow> => build(def, next),
    ...facadeFor(def, () => self),
  });
  // `name` on a function is non-writable, so Object.assign cannot set it.
  Object.defineProperty(self, 'name', { value: name, configurable: true });
  // The declaration goes to `read.ts` and stays there: `sql` has no other reader.
  stashDef(self, def);
  return self;
}

export function describeQuery(target: AnyQuery): QueryDescriptor {
  return {
    kind: 'query',
    name: queryName(target),
    live: target.isLive,
    capability: policyCapability(target.policy),
    tags: tagKeys(target.cache?.tags ?? []),
    ttlMs: target.cache?.ttlMs ?? null,
  };
}

/** Stable identity of a query + its arguments. Used for cursors and live keys. */
export function queryHash(name: string, input: unknown): string {
  return `${name}:${fingerprint(input)}`;
}

/**
 * The read path lives in `read.ts`, next to the declaration store it needs; the
 * primitive stays the package's one front door for it, so a sibling projection
 * never has to know where the store happens to sit.
 */
export { queryName, runQuery, sourceFor } from './read';
