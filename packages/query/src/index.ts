/**
 * Public API of @ultimat3/query: reads, live reads, and the tools around them.
 *
 * `sql` is deliberately absent. A query's declaration lives in `read.ts`'s private
 * store, and `sourceFor` is the only thing that reads it — so no adapter can parse,
 * authorize or execute on its own. One authz system, structurally.
 */

// Anchored on purpose, and not by the `sideEffects` array alone: Bun before 1.4.1 read any array as
// `false` and dropped the module regardless (oven-sh/bun#40650), and a bare import holds on every
// bundler. The array still lists it, because a bundler that honours the array drops a bare import
// of a module it does not list. `registerPrimitiveRegistrar('query', …)` here is read
// by @ultimat3/core's registrar table on behalf of `x` and the manifest, and nothing that registers
// a query imports this module for a binding. `SIDE_EFFECTS_ANCHORS` carries the argument and
// `bun run side-effects` enforces it.
import './registry';

/**
 * Flight control for the typed client, and OPT-IN by construction: `client.ts` names `ClientFlight`
 * as a TYPE only, so a caller that never mentions `clientFlight` pays nothing for the fence,
 * the dedup map or the retry loop. Every mechanism underneath is `@ultimat3/core`'s — one fence,
 * one flight map, one gate, one backoff curve for the whole framework — and so is the pipeline
 * itself: it shipped as a byte-identical copy here and in `@ultimat3/action`, and
 * two tier-3 packages may not import each other, so the one copy lives at tier 0.
 *
 * `ClientFlight` and `ClientRetry` are re-exported as TYPES because this barrel's options name
 * them; every value (`clientFlight`, `isSuperseded`, …) is imported from `@ultimat3/core`,
 * its one home — a re-export is a second import path (`X_HELPER_COPY`, `bun run flight-copies`).
 */
export type { ClientFlight, ClientRetry } from '@ultimat3/core';
/** Re-exported so a `query` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
/**
 * The two refusals `query({ audit: true })` adds. The record and the sink are `@ultimat3/core`'s
 * (`setAuditSink`) — one sink for every audited primitive, so this package re-exports neither.
 */
export { QueryAuditSinkFailedError, QueryAuditSinkMissingError } from './audit-errors';
export type { QueryCacheScope } from './cache';
/** `readAuthority` is the ONLY producer of `cacheKeyFor`'s authority — never spell one by hand. */
export {
  cacheKeyFor,
  DEFAULT_READ_CACHE_TTL_MS,
  readAuthority,
  readOnce,
  readThrough,
  requestMemo,
} from './cache';
export type {
  FetchLike,
  QueryCallOptions,
  QueryClient,
  QueryClientMethod,
  QueryClientMethodOf,
  QueryClientOptions,
  QueryLike,
  QueryMap,
  QuerySingleClientMethod,
} from './client';
/** `queryClient` is the map-wide read client; `queryClientMethodFor` is what `.client()` binds. */
export { queryClient, queryClientMethodFor } from './client';
/**
 * `isNull` is the one definition of SQL NULL a custom `SqlSource` has to agree with, and
 * `totalOrder` is the one definition of the order it must serve a page in. `compareRows`,
 * `matchesFilter` and `isAfterKey` take the relation's declared kinds — `kindsOf(shape.entity)` —
 * because how two values compare is `@ultimat3/entity`'s answer for the column's kind.
 */
export type { KindOf } from './column-kinds';
export { kindsOf } from './column-kinds';
export {
  CursorValueUnsupportedError,
  MatcherUnsupportedError,
  QueryColumnUnselectedError,
  QueryDeniedError,
  QueryDeprecationInvalidError,
  QueryDuplicateError,
  QueryForeignError,
  QueryInputInvalidError,
  QueryInputUnencodableError,
  QueryNotPageableError,
  QueryPolicyMissingError,
  QueryRowNotFoundError,
  QuerySingleInvalidError,
  QuerySubscribesDriftError,
  QuerySubscribesInvalidError,
  QueryUnregisteredError,
} from './errors';
/** The HTTP projection: `GET /_x/query/<kebab>`, the URL `client()` derives. */
export { toQueryRoute } from './http';
export type { LiveCursor, LiveQuery, ResumeMode, ResumePlan, ToLiveOptions } from './live';
export { planResume, seekOf, spendQueryLimit, toLiveQuery } from './live';
export type { ChangeEvent, ChangeOp, Patch } from './matcher';
export { assertMatchable, match, positionFor } from './matcher';
/**
 * The read half of `openapi.json`. `@ultimat3/cli` merges these paths into `@ultimat3/action`'s
 * `buildOpenApi` document — the two packages are one tier and cannot compose each other.
 */
export { queryOpenApiPaths, toQueryOpenApiOperation } from './openapi';
/**
 * The shape the typed client's `.page()` takes. The bound both ends check is `@ultimat3/entity`'s
 * `MAX_PAGE_SIZE` — imported from there, never re-published here.
 */
export type { PageControls } from './page-controls';
/**
 * The shapes `query.page(input, { first, after })` takes and answers with. `paginate` itself is
 * deliberately unexported: a page is the read's own answer, and a second, importable way to ask
 * for one is a second way to do the thing `.page()` already does. The codec is
 * `@ultimat3/core`'s — one place to encode, decode or re-key a cursor.
 */
export type { Page, PaginateArgs } from './pagination';
export type { QueryPolicy, QuerySubject, QuerySurface } from './policy-gate';
/**
 * The one authz gate for reads, named after what it guards. The display label
 * (`policyCapability`), what a report MATCHES on (`policyPermissions`) and what `toQueryRoute`
 * derives `meta.auth` from (`admitsAnonymous`) are `@ultimat3/policy`'s, and the anonymous →
 * `null` mapping (`actorOf`) is `@ultimat3/core`'s — imported from there, never re-published.
 */
export { guardQuery, guardQueryBeforeInput } from './policy-gate';
export type {
  AnyQuery,
  Query,
  QueryCache,
  QueryDef,
  QueryDescriptor,
  QueryFacade,
  QueryOptions,
  QueryRateLimit,
  SourceOptions,
} from './query';
export { describeQuery, isQuery, query, queryHash } from './query';
/** The one read path. `defOf` stays unexported — that is the enforcement. */
export { queryName, runQuery, sourceFor } from './read';
export {
  describeQueries,
  getQuery,
  listQueries,
  registerQueries,
  registerQuery,
  resetQueries,
} from './registry';
/** The query FACTORY over an entity's searchable columns — a `query`, never a ninth primitive. */
export type { SearchChain, SearchDef, SearchInput, SearchPage } from './search';
export { search } from './search';
export type { Filter, FilterOp, OrderKey, QueryShape, SeekKey } from './shape';
export {
  compareRows,
  isNull,
  matchesFilter,
  seekKeyOf,
  totalOrder,
} from './shape';
/** What a `single: true` read answers — one rule, also `@ultimat3/mcp`'s served tool's. */
export { readAnswer } from './single-answer';
/** `Builder` is a type only: `from()` is the one way to build one, so there is no `new Builder()`. */
export type { Builder, RowProvider, SqlSource, SqlText } from './source';
/** `isAfterKey` is the one definition of "after this position" — both seek paths use it. */
export { from, isAfterKey } from './source';
export type { ExplainResult, QuerySqlInfo } from './sql';
export { describeSql, explainQuery } from './sql';
