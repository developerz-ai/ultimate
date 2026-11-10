// `@ultimat3/entity/adapter` — the driver kit. What a custom store (Mongo, Cassandra, a key-value
// store) is built from: `defineDriver` and its contract, and the same plan builders, cursor codec,
// predicate meaning and write guards both shipped drivers use, so a third driver means what they
// mean. Explicit names only; nothing here is reachable from the main barrel's app-facing surface.

export type { AggregateFn } from './aggregate';
export type { UpsertPlan } from './bulk-write';
export { conflictKeyOf, conflictKeys, upsertPlan } from './bulk-write';
export { narrowRow } from './columns';
export { cursorFor, kindOf, seekFrom, valueAt } from './cursor';
export type {
  DriverAdvance,
  DriverCapability,
  DriverDefinition,
  DriverFilter,
  DriverRead,
  DriverRepo,
  DriverWrite,
} from './define-driver';
export { defineDriver } from './define-driver';
export {
  DriverError,
  driverCapabilityMissing,
  driverRowOutOfScope,
  driverUnsupported,
  entityUniqueViolation,
} from './driver-errors';
export { DRIVER_CAPABILITIES } from './driver-kit-types';
export type { DriverStoreKind } from './driver-registry';
export { clearDriverStores, driverStores, noteDriverStore } from './driver-registry';
export { afterSeek, projectRow, selectRows } from './driver-rows';
export { compareByKind, matchesPredicate, sameValueOfKind } from './memory-match';
export {
  DEFAULT_PAGE_SIZE,
  deletePlan,
  idPlan,
  MAX_PAGE_SIZE,
  planFor,
  readPlan,
  singleKeyOf,
  updatePlan,
} from './plan';
export { rowKey } from './row-key';
// The searchIndex port: what an app's Meilisearch/Typesense index implements, and its installer.
export type {
  SearchDocument,
  SearchHit,
  SearchIndex,
  SearchIndexOptions,
  SearchListEntry,
  SearchListPage,
  SearchListQuery,
  SearchQuery,
  SearchScope,
} from './search-index';
export { searchLimitOf, searchListLimitOf } from './search-index';
export { installSearchIndex } from './search-index-installed';
export { searchWords } from './search-index-memory';
// A store's own upsert merges a collision itself: this is the version rule it applies there.
export { advanceVersion } from './search-index-version';
export type { Predicate, QueryPlan, SortKey } from './tenancy';
export { assertRowTenant, scopedPlan } from './tenancy';
export type { UniqueConstraint } from './unique-constraints';
export { uniqueConstraints } from './unique-constraints';
