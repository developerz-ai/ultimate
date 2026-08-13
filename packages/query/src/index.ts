/**
 * Public API of @ultimat3/query: reads, live reads, and the tools around them.
 *
 * `sql` is deliberately absent. A query's declaration lives in `read.ts`'s private
 * store, and `sourceFor` is the only thing that reads it — so no adapter can parse,
 * authorize or execute on its own. One authz system, structurally.
 */

/** Re-exported so a `query` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { ReadCache, ReadCacheEntry } from './cache';
export {
  cacheKeyFor,
  getReadCache,
  invalidateQueryTags,
  MemoryReadCache,
  readOnce,
  readThrough,
  requestMemo,
  setReadCache,
} from './cache';
export type {
  FetchLike,
  QueryCallOptions,
  QueryClientMethod,
  QueryClientOptions,
} from './client';
export { queryClientMethodFor } from './client';
export type { QueryProblem } from './errors';
export {
  CursorInvalidError,
  MatcherUnsupportedError,
  QueryDeniedError,
  QueryDuplicateError,
  QueryForeignError,
  QueryInputInvalidError,
  QueryNotPageableError,
  QueryPolicyMissingError,
  QueryRequestFailedError,
  QueryUnregisteredError,
} from './errors';
export type { LiveCursor, LiveQuery, ResumeMode, ResumePlan, ToLiveOptions } from './live';
export { advanceCursor, liveEpoch, planResume, seekOf, toLiveQuery } from './live';
export type { ChangeEvent, ChangeOp, Patch } from './matcher';
export { assertMatchable, match, positionFor } from './matcher';
export type { QueryToolDescriptor, QueryToolReadOptions } from './mcp-tool';
export { isExposed, toQueryTool, toQueryTools } from './mcp-tool';
export { derivePath, toKebabCase, toToolName } from './naming';
/**
 * The shapes `query.page(input, { first, after })` takes and answers with. `paginate` itself is
 * deliberately unexported: a page is the read's own answer, and a second, importable way to ask
 * for one is a second way to do the thing `.page()` already does. The codec is
 * `@ultimat3/core`'s — one place to encode, decode or re-key a cursor.
 */
export type { Page, PaginateArgs } from './pagination';
export type { QueryPolicy, QuerySubject, QuerySurface } from './policy-gate';
export { actorOf, guard, policyCapability } from './policy-gate';
export type {
  AnyQuery,
  Query,
  QueryCache,
  QueryDef,
  QueryDescriptor,
  QueryFacade,
  QueryMcp,
  QueryOptions,
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
export type { Filter, FilterOp, OrderKey, QueryShape, SeekKey } from './shape';
/** `isNull` is the one definition of SQL NULL a custom `SqlSource` has to agree with. */
export {
  compareRows,
  compareValues,
  isNull,
  matchesFilter,
  matchesFilters,
  seekKeyOf,
} from './shape';
export type { RowProvider, SqlSource, SqlText } from './source';
/** `isAfterKey` is the one definition of "after this position" — both seek paths use it. */
export { Builder, from, isAfterKey } from './source';
export type { ExplainResult, QuerySqlInfo } from './sql';
export { describeSql, explain } from './sql';
