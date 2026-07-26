// Single responsibility: the public API of @ultimat3/db. Explicit named exports only —
// `@ultimat3/auth`, `@ultimat3/entity`, `@ultimat3/jobs` and the CLI are written against this
// list, so anything not here is an implementation detail and may change.

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
export type { DriftDifference, DriftKind, DriftOptions, DriftReport } from './drift';
export {
  assertNoDrift,
  checkDrift,
  diffSchema,
  driftError,
  expectedSchema,
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
  migrationIrreversible,
  readonlyViolation,
  sqlUnsafe,
} from './errors';
export type { RecordedStatement, RecordingClient, StubResponse } from './fake';
export { createRecordingClient } from './fake';
export type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  GeneratedMigration,
  GenerateOptions,
  ParsedIndex,
} from './generate';
export {
  generateMigration,
  migrationStamp,
  parseIndexName,
  slugify,
  snapshotOf,
} from './generate';
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
  LEDGER_TABLE,
  MIGRATION_LOCK_KEY,
  migrate,
  migrationChecksum,
  pendingMigrations,
  readLedger,
  rollback,
  runningAppVersion,
} from './migrate';
export type { PgliteClient, PgliteDriver, PgliteOptions } from './pglite';
export { branchPglite, createPgliteClient, loadPgliteDriver, PGLITE_FIX } from './pglite';
export type { MutationVerdict, ReadOnlyOptions } from './readonly';
export { assertReadOnly, inspectStatement, readOnly, stripSqlNoise } from './readonly';
export type { SqlFragment } from './sql';
export { identifier, isSqlFragment, join, literal, raw, sql } from './sql';
export type { DbTx, IsolationLevel, TransactionOptions } from './transaction';
export { beginStatement, currentTx, withTransaction } from './transaction';
