// The public surface of @ultimat3/entity. Explicit, never `export *`.

/** Re-exported so an `entity` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { AggregateFn } from './aggregate';
export { AVG_SCALE } from './aggregate';
export type { BatchIterator } from './batch';
export type { MoneyColumns } from './column';
export { columnName, moneyColumns, snake } from './column';
export type { MoneyOptions, TextOptions } from './columns';
export {
  boolean,
  enumerated,
  integer,
  locale,
  money,
  newId,
  text,
  timestamp,
  tz,
  url,
  uuid,
} from './columns';
export type { DecimalOptions } from './columns-data';
export { arrayOf, bigint, bytes, date, decimal, json } from './columns-data';
// `crossTenantReason` stays internal: an app that could read the flag would have a second way to
// reason about tenant scope — branch on it — next to the one way, which is entering the scope.
export { CROSS_TENANT_SCOPE, crossTenant } from './cross-tenant';
export type { Database, DatabaseOptions, Driver, EntitySet } from './database';
export { database, defaultDriver, memoryDriver } from './database';
export type { DescribeInput } from './describe';
export { sqlTypeOf } from './describe';
export type { Entity, EntityCore, EntityInit, IndexInit } from './entity';
export { entity, SOFT_DELETE_COLUMN } from './entity';
// The vocabulary an EXISTING schema needs. Separate from the blessed builders on purpose: those
// are decisions this framework made for a table it was going to create, and these are the shapes
// a table already has (`docs`: Entities-And-Migrations, "Adopting an existing database").
export type {
  EntityErrorCode,
  PreloadCandidate,
  QueryLoopBatch,
  WriteLoopBatch,
} from './errors';
// Every error factory this package owns, its three tenancy siblings included: `Driver` is public,
// so a third-party driver has to be able to raise the same refusals the two shipped ones do.
export {
  crossTenantDenied,
  dbDrift,
  ENTITY_ERROR_CODES,
  ENTITY_ERROR_TITLES,
  EntityError,
  entityDuplicate,
  invariantViolated,
  notFound,
  nPlusOneQuery,
  nPlusOneWrite,
  patchEmpty,
  preloadUnknownRelation,
  repoClientPinned,
  tenancyActorMismatch,
  tenancyActorOrgRequired,
  tenancyRowMismatch,
  tenancyUnscoped,
  writeUnfiltered,
} from './errors';
export type { ColumnExpr, Expr, InvariantColumns, Resolve } from './expr';
/** The two DECLARED capabilities' refusals — a third-party driver raises the same ones. */
export type { IllegalTransition } from './feature-errors';
export {
  searchInMemory,
  searchUndeclared,
  stateConflict,
  stateTransitionIllegal,
  stateUndeclared,
} from './feature-errors';
export type { Invariant, InvariantDef, InvariantKind } from './invariants';
export { assertInvariants, invariant, MAX_ASSERTED_ROWS } from './invariants';
export { memoryRepo, memoryTransactor } from './memory-repo';
export type { StatementLoop } from './n-plus-one';
export { N_PLUS_ONE_THRESHOLD, nPlusOne, preloadsFor } from './n-plus-one';
export type { PostgresDriverOptions } from './pg-driver';
export { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
// The two page bounds, beside `N_PLUS_ONE_THRESHOLD` and for the same reason: an app validating
// its own `pageSize` input against a hardcoded 10_000 is a second declaration of one number.
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './plan';
export type { RelatedTable, RelatedTables } from './preload';
export type { Preloaded, ReadBuilder, Table } from './query';
export { tableFor } from './query';
export type {
  ColumnDescription,
  EntityDescription,
  IndexDescription,
  InvariantDescription,
  ReferenceDescription,
  RegistryEntry,
} from './registry';
export {
  clearRegistry,
  describeEntities,
  entityNames,
  getEntity,
  registerEntity,
  registeredEntities,
} from './registry';
export type { EntityRelations, Relation, RelationKind, RelationMap } from './relations';
export { relationMap, relationNamed, relationsFor, relationsOf } from './relations';
export type {
  FindByIdOptions,
  FindManyArgs,
  MemoryRepo,
  Page,
  Repo,
  RepoOptions,
  Transactor,
  Tx,
  UpsertArgs,
} from './repo';
export type { RowBulkChange, RowChange, RowChangeOp, RowObserver } from './row-observer';
export { observedRepo, rowObserver, setRowObserver } from './row-observer';
// Full-text search. The LANGUAGE set and the weights are values an app reads to build a form;
// `SEARCH_PROPERTY` is what a `matches` predicate names, which a hand-built `QueryPlan` needs.
export type { SearchInit, SearchLanguage, SearchSource, SearchVector } from './search';
export {
  DEFAULT_SEARCH_COLUMN,
  DEFAULT_SEARCH_LANGUAGE,
  DEFAULT_SEARCH_WEIGHT,
  isSearchLanguage,
  isSearchWeight,
  SEARCH_LANGUAGES,
  SEARCH_PROPERTY,
  SEARCH_WEIGHTS,
  searchExpression,
} from './search';
export type {
  Seed,
  SeedContext,
  SeedInit,
  SeedKey,
  SeedMetrics,
  SeedOptions,
  SeedRun,
  SeedTier,
  SeedWrite,
} from './seed';
export { defineSeed, isSeed, SEED_TIERS, seedId, seedTiersFor } from './seed';
// A state machine over a column. The MECHANISM only: the table, the refusal, the terminal concept.
// The states are the app's `enumerated()` set and nothing here names one.
export type { StateMachine, TransitionTable } from './state-machine';
export {
  canMove,
  isState,
  isTerminal,
  movesFrom,
  stateMachineOf,
} from './state-machine';
export type { Operator, Predicate, QueryPlan, SortDirection, SortKey } from './tenancy';
export {
  assertRowTenant,
  assertScoped,
  describePlan,
  emptyPlan,
  hasOrgPredicate,
  isOrgScoped,
  ORG_COLUMN,
  orgScoped,
  scopedPlan,
  tenantColumnOf,
} from './tenancy';
export type { Move } from './transition';
export type {
  AnyColumn,
  Column,
  ColumnDefault,
  ColumnKind,
  ColumnMap,
  ColumnMeta,
  EnumeratedColumn,
  IdOf,
  IndexDef,
  Insertable,
  MoneyColumnNames,
  MoneyInput,
  MoneyValue,
  OnDelete,
  ReferenceOptions,
  RowOf,
  RowPatch,
  RowWrite,
  SearchWeight,
  TimestampColumn,
  TypeOf,
  UuidColumn,
} from './types';
export { COLUMN_KINDS } from './types';
// `viewFor` stays internal: a view is reached through the entity, as `posts.$view([...])`.
export type { EntityView } from './view';
