/**
 * Public API of @ultimat3/query: reads, live reads, and the tools around them.
 *
 * `sql` is deliberately absent. A query's declaration lives in `read.ts`'s private
 * store, and `sourceFor` is the only thing that reads it — so no adapter can parse,
 * authorize or execute on its own. One authz system, structurally.
 */

/**
 * Flight control for the typed client, and OPT-IN by construction: `client.ts` names `ClientFlight`
 * as a TYPE only, so a caller that never mentions `createClientFlight` pays nothing for the fence,
 * the dedup map or the retry loop. Every mechanism underneath is `@ultimat3/core`'s — one fence,
 * one flight map, one gate, one backoff curve for the whole framework — and so is the pipeline
 * itself: it shipped as a byte-identical copy here and in `@ultimat3/action`, and
 * two tier-3 packages may not import each other, so the one copy lives at tier 0.
 *
 * Re-exported rather than re-declared, so every name is importable from this package exactly as
 * before. `isSuperseded` is core's too: reading a fenced answer is the point of installing a
 * flight, and it should not cost a second import.
 */
export type {
  ClientFlight,
  ClientFlightOptions,
  ClientRetry,
  FlightKeyOptions,
  FlightPlan,
  WireAnswer,
} from '@ultimat3/core';
export {
  createClientFlight,
  DEFAULT_CLIENT_RETRY,
  isSuperseded,
  isTransientFailure,
} from '@ultimat3/core';
/** Re-exported so a `query` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
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
  QueryClientOptions,
  QueryLike,
  QueryMap,
} from './client';
/** `queryClient` is the map-wide read client; `queryClientMethodFor` is what `.client()` binds. */
export { queryClient, queryClientMethodFor } from './client';
/** The compat window a retirement gets. Versioning is two deployments, not a router feature. */
export type { Deprecation, DeprecationField, DeprecationRender } from './deprecation';
export { recordDeprecatedCall, renderDeprecation } from './deprecation';
export type { QueryProblem } from './errors';
export {
  CursorInvalidError,
  CursorValueUnsupportedError,
  MatcherUnsupportedError,
  QueryDeniedError,
  QueryDeprecationInvalidError,
  QueryDuplicateError,
  QueryForeignError,
  QueryInputInvalidError,
  QueryInputUnencodableError,
  QueryNotPageableError,
  QueryPolicyMissingError,
  QueryRequestFailedError,
  QueryUnregisteredError,
} from './errors';
/** The HTTP projection: `GET /_x/query/<kebab>`, the URL `client()` derives. */
export { toQueryRoute } from './http';
export type { LiveCursor, LiveQuery, ResumeMode, ResumePlan, ToLiveOptions } from './live';
export { advanceCursor, liveEpoch, planResume, seekOf, toLiveQuery } from './live';
export type { ChangeEvent, ChangeOp, Patch } from './matcher';
export { assertMatchable, match, positionFor } from './matcher';
export type { QueryToolDescriptor, QueryToolReadOptions } from './mcp-tool';
export { isExposed, toQueryTool, toQueryTools } from './mcp-tool';
/**
 * Path derivation only. There is no `toToolName`: an MCP tool is served under the export name
 * verbatim, and an exported derivation would be a second way to spell one tool.
 */
export { derivePath, toKebabCase } from './naming';
/**
 * The shapes `query.page(input, { first, after })` takes and answers with. `paginate` itself is
 * deliberately unexported: a page is the read's own answer, and a second, importable way to ask
 * for one is a second way to do the thing `.page()` already does. The codec is
 * `@ultimat3/core`'s — one place to encode, decode or re-key a cursor.
 */
export type { Page, PaginateArgs } from './pagination';
export type { QueryPolicy, QuerySubject, QuerySurface } from './policy-gate';
/**
 * `policyCapability` is the display label; `policyPermissions` is what a report MATCHES on.
 * `admitsAnonymous` is `@ultimat3/policy`'s, re-exported here beside them: it is what
 * `toQueryRoute` derives `meta.auth` from, so a plain `route` sets that field from the same walk
 * rather than re-reading the root combinator.
 */
export {
  actorOf,
  admitsAnonymous,
  guard,
  policyCapability,
  policyPermissions,
} from './policy-gate';
export type {
  AnyQuery,
  Query,
  QueryCache,
  QueryDef,
  QueryDescriptor,
  QueryFacade,
  QueryMcp,
  QueryOptions,
  QueryRateLimit,
  SourceOptions,
} from './query';
export { describeQuery, isQuery, nameQuery, query, queryHash } from './query';
/** The one read path. `defOf` stays unexported — that is the enforcement. */
export { queryName, runQuery, sourceFor } from './read';

export {
  describeQueries,
  getQuery,
  listQueries,
  registerQueries,
  registerQuery,
  resetRegistry,
} from './registry';
/** The query FACTORY over an entity's searchable columns — a `query`, never a ninth primitive. */
export type { SearchChain, SearchDef, SearchInput, SearchPage } from './search';
export { search } from './search';
export type { Filter, FilterOp, OrderKey, QueryShape, SeekKey } from './shape';
/**
 * `isNull` is the one definition of SQL NULL a custom `SqlSource` has to agree with, and
 * `totalOrder` is the one definition of the order it must serve a page in.
 */
export {
  compareRows,
  compareValues,
  isNull,
  matchesFilter,
  matchesFilters,
  seekKeyOf,
  totalOrder,
} from './shape';
export type { RowProvider, SqlSource, SqlText } from './source';
/** `isAfterKey` is the one definition of "after this position" — both seek paths use it. */
export { Builder, from, isAfterKey } from './source';
export type { ExplainResult, QuerySqlInfo } from './sql';
export { describeSql, explain } from './sql';
