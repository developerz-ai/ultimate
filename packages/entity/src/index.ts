// The public surface of @ultimat3/entity. Explicit, never `export *`.

export type { MoneyColumns } from './columns';
export {
  boolean,
  enumerated,
  id,
  integer,
  jsonb,
  locale,
  money,
  newId,
  nullable,
  orgId,
  references,
  slug,
  softDelete,
  table,
  text,
  timestamp,
  timestamps,
  tz,
  url,
  // Exported as `uuid`: in a schema, `uuid()` reads as a column type. The v7 *generator*
  // is `newId()`, so the two never collide at a call site.
  uuidColumn as uuid,
} from './columns';
export type { Entity, EntityInit, EntitySchema } from './entity';
export { entity } from './entity';
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
export type { CheckInit, Invariant, InvariantKind, UniqueInit } from './invariants';
export {
  assertInvariants,
  constraintName,
  invariant,
  invariantsToSql,
  toSql,
  unique,
} from './invariants';
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
export { decodeCursor, encodeCursor, memoryRepo, memoryTransactor } from './repo';
export type { Operator, Predicate, QueryPlan, SortDirection } from './tenancy';
export {
  assertScoped,
  describePlan,
  emptyPlan,
  hasOrgPredicate,
  isOrgScoped,
  ORG_COLUMN,
  orgScoped,
} from './tenancy';
export type {
  ColumnDef,
  ColumnDefault,
  ColumnKind,
  ColumnMap,
  IndexDef,
  ReferenceDef,
  RowOf,
  TableDef,
} from './types';
export { columnNames, hasColumn } from './types';
