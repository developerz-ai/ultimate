/** Public API of @ultimat3/query: reads, live reads, and the tools around them. */

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
export {
  CursorInvalidError,
  MatcherUnsupportedError,
  QueryDeniedError,
  QueryDuplicateError,
  QueryInputInvalidError,
  QueryPolicyMissingError,
  QueryUnregisteredError,
} from './errors';
export type { LiveCursor, LiveQuery, ResumeMode, ResumePlan, ToLiveOptions } from './live';
export { advanceCursor, liveEpoch, planResume, seekOf, toLiveQuery } from './live';
export type { ChangeEvent, ChangeOp, Patch } from './matcher';
export { assertMatchable, match, positionFor } from './matcher';
export type { CursorPayload, Page, PaginateArgs } from './pagination';
export { configureCursorSigning, decodeCursor, encodeCursor, paginate } from './pagination';
export type { QueryPolicy, QuerySubject, QuerySurface } from './policy-gate';
export { actorOf, guard, policyCapability } from './policy-gate';
export type {
  AnyQuery,
  AnyQueryDef,
  Query,
  QueryCache,
  QueryDef,
  QueryDescriptor,
  QueryOptions,
  SourceOptions,
} from './query';
export { isQuery, query, queryHash, queryName, runQuery, sourceFor } from './query';
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
