// The public surface of @ultimat3/entity. Explicit, never `export *`.

/** Re-exported so an `entity` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
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
export type { Cursor } from './cursor';
export { decodeCursor, encodeCursor } from './cursor';
export type { Database, DatabaseOptions, Driver, EntitySet } from './database';
export { database, memoryDriver } from './database';
export type { Entity, EntityCore, EntityInit, IndexInit } from './entity';
export { entity, SOFT_DELETE_COLUMN } from './entity';
export type { EntityErrorCode } from './errors';
export {
  dbDrift,
  ENTITY_ERROR_CODES,
  ENTITY_ERROR_TITLES,
  EntityError,
  entityDuplicate,
  invariantViolated,
  notFound,
  tenancyUnscoped,
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
export type { PostgresDriverOptions } from './pg-driver';
export { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
export type { ReadBuilder, Table } from './query';
export { tableFor } from './query';
export type {
  ColumnDescription,
  EntityDescription,
  InvariantDescription,
  RegistryEntry,
} from './registry';
export {
  clearRegistry,
  describeEntities,
  entityNames,
  getEntity,
  registerEntity,
} from './registry';
export type { FindManyArgs, Page, Repo, RepoOptions, Transactor, Tx } from './repo';
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
