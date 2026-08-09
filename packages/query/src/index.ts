/**
 * Public API of @ultimat3/query: reads, live reads, and the tools around them.
 *
 * `sql` is deliberately absent. A query's declaration lives in `read.ts`'s private
 * store, and `sourceFor` is the only thing that reads it — so no adapter can parse,
 * authorize or execute on its own. One authz system, structurally.
 */

export type { ReadCache, ReadCacheEntry } from './cache';
export {
  cacheKeyFor,
  getReadCache,
  invalidateQueryTags,
  MemoryReadCache,
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
export type { CursorPayload, Page, PaginateArgs } from './pagination';
export { configureCursorSigning, decodeCursor, encodeCursor, paginate } from './pagination';
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
export { compareRows, compareValues, matchesFilter, matchesFilters, seekKeyOf } from './shape';
export type { RowProvider, SqlSource, SqlText } from './source';
export { Builder, from } from './source';
export type { ExplainResult, QuerySqlInfo } from './sql';
export { describeSql, explain } from './sql';
