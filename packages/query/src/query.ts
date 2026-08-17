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
import type { QueryCacheScope } from './cache';
import type { QueryClientMethod, QueryClientOptions } from './client';
import type { Deprecation } from './deprecation';
import { QueryCacheTtlInvalidError } from './errors';
import { facadeFor } from './facade';
import { assertEncodableInput } from './input-shape';
import type { LiveQuery, ToLiveOptions } from './live';
import type { QueryToolDescriptor } from './mcp-tool';
import type { Page, PaginateArgs } from './pagination';
import type { QueryPolicy, QuerySurface } from './policy-gate';
import { policyCapability, policyPermissions } from './policy-gate';
import { hasDef, queryName, runQuery, stashDef } from './read';
import type { SqlSource } from './source';
import { fingerprint } from './stable';
import { tagKeys } from './tags';

export interface QueryCache {
  /** Tags this read depends on. An action's `invalidates` drops exactly these keys. */
  readonly tags: readonly CacheTag[];
  /**
   * Lifetime of a tier entry. Positive and finite — `Infinity`, `0` and `NaN` are refused at
   * `query()` (`X_QUERY_CACHE_TTL_INVALID`), where the file that wrote them fails, rather than on
   * every read of that query forever. Omitted takes `DEFAULT_READ_CACHE_TTL_MS`.
   */
  readonly ttlMs?: number;
  /**
   * Who a cached answer may be handed back to. **Defaults to `actor`**, and that default is the
   * mechanism: a read that declares nothing gets the narrowest key, which is always correct.
   * `tenant` and `global` are written statements that the rows do not depend on the caller beyond
   * their org, or at all — see `readAuthority`.
   */
  readonly scope?: QueryCacheScope;
}

export interface QueryMcp {
  /** Opt-in: a read reaches an agent only when it says so. Silence exposes nothing. */
  readonly expose: boolean;
  /** Contract text, not UI text — see `ActionMcp.description` for why it stays outside `t()`. */
  readonly description?: string;
  /**
   * Roles that may SEE the projected tool — a catalog audience, not an authz rule; the `policy`
   * still decides every call. A caller whose role is not named gets ToolNotFound, never
   * Forbidden. See `ActionMcp.visibleTo`, which this mirrors exactly.
   */
  readonly visibleTo?: readonly string[];
}

/**
 * The symmetric twin of `ActionRateLimit`, and the field whose absence meant a read could not be
 * throttled at all: every `GET /_x/query/*` fell through to the `default` bucket (120 burst, 2/s
 * per actor), so one authenticated caller could hold 120 cross-tenant aggregates in flight and
 * then 2/s forever, from a single account, with no declaration able to say otherwise.
 */
export interface QueryRateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface QueryDef<TInput extends StandardSchemaV1, TRow extends object> {
  readonly input: TInput;
  readonly policy: QueryPolicy;
  /** `true` makes the read subscribable — see `toLiveQuery`. */
  readonly live?: boolean;
  sql(input: InferOutput<TInput>, ctx: Ctx): SqlSource<TRow>;
  readonly cache?: QueryCache;
  readonly mcp?: QueryMcp;
  /** Burst and refill for THIS read's route, in the limiter's own vocabulary. */
  readonly rateLimit?: QueryRateLimit;
  /**
   * On its way out. `Deprecation` and `Sunset` response headers (RFC 9745 / RFC 8594), a
   * `rel="successor-version"` link when `replacedBy` names one, and a
   * `deprecated_calls_total{name}` counter — the only way to answer "is anyone still reading
   * it?" before deleting it. Versioning itself is two deployments behind one ingress, not a
   * router feature; see the README.
   */
  readonly deprecated?: Deprecation;
}

export interface QueryOptions {
  readonly ctx?: Ctx;
  readonly surface?: QuerySurface;
  /**
   * Skips every cache for this call — the request memo as well as the tiers, since a memo is a
   * cache with a request's lifetime. The one way to read past a write made earlier in the same
   * request: what it reads replaces the memo entry, so the next plain read of this key in this
   * request sees the write too. Live fanout always reads fresh.
   */
  readonly fresh?: boolean;
  /**
   * Run as someone else. Omitted keeps the context's own actor; `null` is the
   * signed-out caller. The rest of the context is untouched, so impersonation
   * stays on the one read path instead of forking a second one.
   */
  readonly actor?: Actor | null;
}

export interface SourceOptions extends QueryOptions {
  /**
   * Build this source WITHOUT evaluating its policy, and say WHY — a written reason, never a bare
   * boolean. It was `enforce: false`, and a boolean is wrong here for the reason
   * `@ultimat3/entity`'s `cross-tenant.ts` gives for the same shape: it reads exactly like
   * forgetting the check. The reason is the mechanism, not documentation of it — a blank one is
   * refused (`X_INVARIANT`), so an escape with no argument cannot be written at all, and every
   * skipped policy in a codebase is one `grep` away with the justification attached.
   *
   * Two situations qualify, and both are reads with no subscriber to decide about: developer
   * tooling that returns no rows (`explain`, `describeSql`) and the shared, subject-less window a
   * sync node builds once per `(query, input)` — see `ToLiveOptions.enforce`, which is that one
   * use spelled as a boolean because it has exactly one reason and this file already states it.
   *
   * It is deliberately NOT gated on a capability the way `crossTenant` is: `explain` runs from the
   * CLI with no actor at all to check one against, so a scope requirement would close the one
   * surface this exists for. The rows are still tenant-scoped by `@ultimat3/entity` under the
   * caller's own context, which `read.ts` now installs.
   */
  readonly unenforced?: string;
}

export interface QueryDescriptor {
  readonly kind: 'query';
  readonly name: string;
  readonly live: boolean;
  /** The policy's DISPLAY label. A composite renders as `or(a:b, c:d)` — never a permission. */
  readonly capability: string;
  /**
   * Every permission the policy tree references, flattened. The field a compliance report
   * matches a grant against; `capability` is a label and matching on it reported every
   * composite-guarded read as enforcing nothing.
   */
  readonly permissions: readonly string[];
  readonly tags: readonly string[];
  readonly ttlMs: number | null;
  readonly rateLimit: QueryRateLimit | null;
  readonly deprecated: Deprecation | null;
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
  readonly rateLimit?: QueryRateLimit;
  readonly deprecated?: Deprecation;
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
  /** Lifted so `toQueryRoute` reads the declaration without reaching through `defOf`. */
  readonly rateLimit?: QueryRateLimit;
  readonly deprecated?: Deprecation;
  describe(): QueryDescriptor;
  /** A twin under another name. Registration names through `named`. */
  named(name: string): AnyQuery;
  /** Read as this actor. Same read path, only the context's actor changes. */
  as(actor: Actor | null, input: unknown, options?: QueryOptions): Promise<readonly object[]>;
  /** One bounded page plus the signed cursor that continues it. There is no `offset`. */
  page(input: unknown, args: PaginateArgs): Promise<Page<object>>;
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
  page(input: InferInput<TInput>, args: PaginateArgs): Promise<Page<TRow>>;
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
  | 'input'
  | 'policy'
  | 'cache'
  | 'mcp'
  | 'rateLimit'
  | 'deprecated'
  | 'as'
  | 'page'
  | 'live'
  | 'tool'
  | 'client'
>;

export function query<TInput extends StandardSchemaV1, TRow extends object>(
  def: QueryDef<TInput, TRow>,
): Query<TInput, TRow> {
  // Here and not in `toQueryRoute`: a read is projected to `GET /_x/query/<kebab>` whether or not
  // anyone mounts it, and the typed client derives that same URL — so an input a query string
  // cannot carry is wrong for every call, and the file that declared it is where it is repaired.
  assertEncodableInput(def.input);
  assertCacheTtl(def.cache);
  return build(def, '');
}

/**
 * The same rule, for the same reason: a lease every `CacheTier` refuses is wrong for every read of
 * this query, so it fails on the line that wrote it rather than on the first request. Positive and
 * finite is `assertTtl`'s bar in `@ultimat3/cache`, restated as a refusal and never as a second
 * resolution — there is no "never expires" to fall back to.
 */
function assertCacheTtl(cache: QueryCache | undefined): void {
  const ttlMs = cache?.ttlMs;
  if (ttlMs === undefined) return;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new QueryCacheTtlInvalidError(ttlMs);
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
    // The flattened list, beside the label and never instead of it: one is read, one is matched.
    permissions: policyPermissions(target.policy),
    tags: tagKeys(target.cache?.tags ?? []),
    ttlMs: target.cache?.ttlMs ?? null,
    rateLimit: target.rateLimit ?? null,
    deprecated: target.deprecated ?? null,
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
