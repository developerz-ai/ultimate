// Single responsibility: the public API of @ultimat3/db. Explicit named exports only —
// `@ultimat3/auth`, `@ultimat3/entity`, `@ultimat3/jobs` and the CLI are written against this
// list, so anything not here is an implementation detail and may change.

export { statementAttribution, withStatementAttribution } from './attribution';
export type { BranchInfo, BranchOptions, DropBranchOptions, ReapOptions } from './branch';
export {
  assertBranchName,
  createBranch,
  currentDatabase,
  dropBranch,
  listBranches,
  reapBranches,
} from './branch';
export type {
  DbClient,
  DbConnection,
  DbHealthReport,
  PoolProfile,
  PostgresClient,
  PostgresClientOptions,
  ReservableClient,
} from './client';
export {
  baseClient,
  checkDb,
  createPostgresClient,
  db,
  isReservable,
  POOL_PROFILES,
  poolProfileFor,
  setDbClient,
} from './client';
export type { DestructiveKind, DestructiveStatement } from './destructive';
export {
  DESTRUCTIVE_CAUSE,
  DESTRUCTIVE_MARKER,
  destructiveStatements,
  hasDestructiveMarker,
  isDestructive,
} from './destructive';
export type { DriftDifference, DriftKind, DriftOptions, DriftReport } from './drift';
export {
  appTables,
  assertNoDrift,
  checkDrift,
  declaredSchema,
  diffSchema,
  driftError,
  expectedSchema,
  FRAMEWORK_TABLE_PREFIX,
} from './drift';
export type { DbErrorCode, DbErrorInit } from './errors';
export {
  branchExists,
  branchNameInvalid,
  DB_ERROR_CODES,
  DB_ERROR_TITLES,
  DbError,
  dbDrift,
  dbNotImplemented,
  dbUnavailable,
  identifierUnsafe,
  migrationConflict,
  migrationDestructive,
  migrationIrreversible,
  migrationSnapshotMissing,
  multipleStatements,
  readonlyViolation,
  sqlUnsafe,
} from './errors';
export { expectedQueryLoop, expectedQueryLoopReason } from './expected-loop';
export type { RecordedStatement, RecordingClient, StubResponse } from './fake';
export { createRecordingClient } from './fake';
export type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  GeneratedMigration,
  GenerateOptions,
  IndexDescriptionLike,
} from './generate';
export { generateMigration, migrationStamp, slugify, snapshotOf } from './generate';
export type {
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  IntrospectOptions,
  SchemaDescription,
  TableDescription,
} from './introspect';
export { buildSchema, findTable, introspect } from './introspect';
export type {
  AppliedMigration,
  LedgerRow,
  MigrateOptions,
  Migration,
  MigrationReport,
  RollbackOptions,
} from './migrate';
export {
  auditLedger,
  checksumOf,
  ensureLedger,
  isLedgerMissing,
  LEDGER_TABLE,
  MIGRATION_LOCK_KEY,
  migrate,
  migrationChecksum,
  pendingMigrations,
  readLedger,
  rollback,
  runningAppVersion,
} from './migrate';
export type { StatementAttribution, StatementEvent, StatementObserver } from './observe';
export { setStatementObserver, statementObserver } from './observe';
export type {
  PgliteClient,
  PgliteDriver,
  PgliteLoader,
  PgliteModule,
  PgliteOptions,
  PgliteResult,
} from './pglite';
export {
  createPgliteClient,
  loadPgliteDriver,
  PGLITE_FIX,
  PGLITE_MEMORY,
  pgliteDataDir,
} from './pglite';
export type { PgliteBranchInfo, PgliteBranchOptions } from './pglite-branch';
export { branchPglite, pgliteBranchDir } from './pglite-branch';
export type { MutationVerdict, ReadOnlyOptions } from './readonly';
export { assertReadOnly, inspectStatement, readOnly } from './readonly';
export type { ReadOnlyQueryOptions, ReadOnlyQueryResult } from './readonly-query';
export { READONLY_TIMEOUT_MS, readOnlyQuery } from './readonly-query';
export type { ReadOnlyRoleOptions } from './readonly-role';
export { ensureReadOnlyRole, grantReadOnlySql, READONLY_ROLE } from './readonly-role';
export { parseSnapshot } from './snapshot-parse';
export type { SqlFragment } from './sql';
export { identifier, isSqlFragment, join, literal, raw, sql } from './sql';
export { stripSqlNoise } from './sql-noise';
export { statementFingerprint, statementKind, statementVerb } from './statement-shape';
export { STATEMENT_ATTRIBUTE } from './statement-span';
export { statementsOf } from './statement-split';
export type { DbTx, IsolationLevel, TransactionOptions } from './transaction';
export { beginStatement, currentTx, withTransaction } from './transaction';
