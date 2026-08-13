// The public surface of @ultimat3/entity. Explicit, never `export *`.

/** Re-exported so an `entity` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { BatchIterator } from './batch';
export type { TextOptions } from './columns';
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
export type { Database, DatabaseOptions, Driver, EntitySet } from './database';
export { database, memoryDriver } from './database';
export type { Entity, EntityCore, EntityInit, IndexInit } from './entity';
export { entity, SOFT_DELETE_COLUMN } from './entity';
export type {
  EntityErrorCode,
  PreloadCandidate,
  QueryLoopBatch,
  WriteLoopBatch,
} from './errors';
export {
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
  tenancyUnscoped,
  writeUnfiltered,
} from './errors';
export type { ColumnExpr, Expr, InvariantColumns, Resolve } from './expr';
export type { Invariant, InvariantDef, InvariantKind } from './invariants';
export {
  assertInvariants,
  constraintName,
  invariant,
  invariantsToSql,
  toSql,
} from './invariants';
export type { StatementLoop } from './n-plus-one';
export { N_PLUS_ONE_THRESHOLD, nPlusOne, preloadsFor } from './n-plus-one';
export type { PostgresDriverOptions } from './pg-driver';
export { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
export type { RelatedTable, RelatedTables } from './preload';
export type { Preloaded, ReadBuilder, Table } from './query';
export { tableFor } from './query';
export type {
  ColumnDescription,
  EntityDescription,
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
  FindManyArgs,
  Page,
  Repo,
  RepoOptions,
  Transactor,
  Tx,
  UpsertArgs,
} from './repo';
export { memoryRepo, memoryTransactor } from './repo';
export type { Seed, SeedContext, SeedOptions } from './seed';
export { defineSeed, seedId } from './seed';
export type { Operator, Predicate, QueryPlan, SortDirection, SortKey } from './tenancy';
export {
  assertScoped,
  describePlan,
  emptyPlan,
  hasOrgPredicate,
  isOrgScoped,
  ORG_COLUMN,
  orgScoped,
  tenantColumnOf,
} from './tenancy';
export type {
  AnyColumn,
  Column,
  ColumnDefault,
  ColumnKind,
  ColumnMap,
  ColumnMeta,
  IdOf,
  IndexDef,
  Insertable,
  MoneyInput,
  MoneyValue,
  OnDelete,
  ReferenceOptions,
  RowOf,
  TimestampColumn,
  TypeOf,
  UuidColumn,
} from './types';
// `viewFor` stays internal: a view is reached through the entity, as `posts.$view([...])`.
export type { EntityView } from './view';
