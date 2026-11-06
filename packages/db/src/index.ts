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
export {
  checkClauses,
  checkPlan,
  columnCheckName,
  columnChecks,
  columnNamesConstraint,
  declaredChecks,
} from './check-ddl';
export type {
  DbClient,
  DbConnection,
  PostgresClient,
  PostgresClientOptions,
  ReservableClient,
} from './client';
export {
  baseClient,
  db,
  dbClientInstalled,
  isReservable,
  postgresClient,
  setDbClient,
} from './client';
export type { ColumnDefaultLike } from './column-default';
export { defaultExpression } from './column-default';
export {
  concurrentIndexTarget,
  isConcurrentIndexStatement,
  isNonTransactional,
  isPartitionedBuildRefusal,
  NO_TRANSACTION_MARKER,
} from './concurrent-index';
export { dbExecutor } from './db-executor';
export type { DbHealthReport } from './db-health';
export { checkDb } from './db-health';
export {
  generatedExpressionUnsafe,
  indexOrderInvalid,
  indexPredicateUnsafe,
} from './ddl-errors';
export { defaultClient, REPLICA_URL_ENV } from './default-client';
export type { DestructiveKind, DestructiveStatement } from './destructive';
export {
  DESTRUCTIVE_CAUSE,
  DESTRUCTIVE_MARKER,
  destructiveStatements,
  hasDestructiveMarker,
  isDestructiveMigration,
} from './destructive';
export type { DriftDifference, DriftKind, DriftOptions, DriftReport } from './drift';
export {
  appTables,
  assertNoSchemaDrift,
  checkDrift,
  declaredSchema,
  diffSchema,
  driftError,
  expectedSchema,
  FRAMEWORK_TABLE_PREFIX,
} from './drift';
export { dbDrift } from './drift-errors';
export type { RowSecurityDifference } from './drift-row-security';
export { rowSecurityDifferences, rowSecurityDrift } from './drift-row-security';
export type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
  InvariantDescriptionLike,
} from './entity-shape';
export type { DbErrorCode, DbErrorInit } from './errors';
export {
  branchExists,
  branchNameInvalid,
  DB_ERROR_CODES,
  DB_ERROR_RETRY,
  DB_ERROR_TITLES,
  DbError,
  dbUnavailable,
  driverError,
  identifierUnsafe,
  multipleStatements,
  poolAcquireTimeout,
  poolMaxInvalid,
  serializationExhausted,
  sqlUnsafe,
} from './errors';
export { expectedQueryLoop, expectedQueryLoopReason } from './expected-loop';
export type { RecordedStatement, RecordingClient, StubResponse } from './fake';
export { recordingClient } from './fake';
export type { GeneratedMigration, GenerateOptions } from './generate';
export { generateMigration, migrationStamp, slugify, snapshotOf } from './generate';
export type { RowSecurityOption, TenantColumnLike } from './generate-row-security';
export type { IndexMethod } from './index-method';
export {
  declaredMethod,
  INDEX_METHODS,
  indexMethodOf,
  indexMethodSql,
  isIndexMethod,
} from './index-method';
export type {
  CheckDescription,
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  IntrospectOptions,
  SchemaDescription,
  TableDescription,
} from './introspect';
export { buildSchema, findTable, introspectSchema } from './introspect';
export {
  constraintNameFor,
  declaredIndexes,
  invariantChecks,
  uniqueColumns,
} from './invariant-ddl';
export { constraintExpressionUnsafe, constraintNameUnsafe } from './invariant-errors';
export type { DbSubscription, ListeningClient } from './listen';
export { canListen } from './listen';
export type { LocalSettings } from './local-settings';
export { readLocal, setLocal } from './local-settings';
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
  MIGRATION_LOCK_POLL_MS,
  MIGRATION_LOCK_WAIT_MS,
  migrate,
  migrationChecksum,
  pendingMigrations,
  readLedger,
  rollback,
  runningAppVersion,
} from './migrate';
export {
  migrateConcurrent,
  migrationConcurrentInTransaction,
  migrationConcurrentPartitioned,
  migrationConflict,
  migrationDestructive,
  migrationIrreversible,
  migrationSnapshotMissing,
  migrationViewDepends,
  rollbackStepsInvalid,
} from './migration-errors';
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
  loadPgliteDriver,
  PGLITE_FIX,
  PGLITE_MEMORY,
  PGLITE_MISSING,
  PGLITE_PACKAGE,
  pgliteClient,
  pgliteDataDir,
} from './pglite';
export type { PgliteBranchInfo, PgliteBranchOptions } from './pglite-branch';
export { branchPglite, pgliteBranchDir } from './pglite-branch';
export type { LinkedExtensions, PgliteExtensionLoader } from './pglite-extensions';
export { linkPgliteExtensions } from './pglite-extensions';
export { pgliteVersion } from './pglite-snapshot';
export type { PoolProfile } from './pool-profile';
export {
  POOL_MAX_ENV,
  POOL_PROFILES,
  poolMaxFromEnv,
  poolProfileFor,
} from './pool-profile';
export type { PoolerMode, StatementBound } from './pooler';
export {
  lostStatementBound,
  POOLER_ENV,
  POOLER_WAIT_MS,
  poolerFromEnv,
  poolerSessionRequired,
  statementBound,
} from './pooler';
export type { ReadTransactionOptions } from './read-transaction';
export { withReadTransaction } from './read-transaction';
export type { ReadOnlyQueryOptions, ReadOnlyQueryResult } from './readonly-query';
export { READONLY_TIMEOUT_MS, readOnlyQuery } from './readonly-query';
export type { ReadOnlyRoleOptions } from './readonly-role';
export { ensureReadOnlyRole, grantReadOnlySql, READONLY_ROLE } from './readonly-role';
export type {
  ReplicaStats,
  ReplicatedClient,
  ReplicatedClientOptions,
} from './replica-client';
export { BREAKER_COOLDOWN_MS, BREAKER_FAILURES, replicatedClient } from './replica-client';
export type { ReplayReader } from './replica-position';
export {
  formatPosition,
  POSITION_CACHE_MS,
  parsePosition,
  primaryPosition,
  replayReader,
} from './replica-position';
export { type DbNode, isPlainRead } from './replica-route';
export type { ReplicaReadsOptions, ReplicaScope } from './replica-scope';
export { markScopeWrote, replicaScope, withReplicaReads } from './replica-scope';
export { recordRetired } from './retired';
export type { RollingUnsafeKind, RollingUnsafeStatement } from './rolling';
export {
  hasRollingUnsafeMarker,
  ROLLING_UNSAFE_MARKER,
  retiredColumnsIn,
  rollingUnsafeStatements,
  unretiredColumnsIn,
} from './rolling';
export { migrationRollingUnsafe } from './rolling-errors';
export { rowSecureClient } from './row-secure-client';
export {
  CROSS_TENANT_SETTING,
  dropRowSecuritySql,
  enableRowSecuritySql,
  ROW_SECURITY_POLICY,
  TENANT_SETTING,
} from './row-security';
export { holdMigratorRole, migratorOwnershipSql } from './row-security-migrator';
export type { RowSecurityPlanInput, TenantTable } from './row-security-plan';
export { rowSecurityAfter, rowSecurityPlan } from './row-security-plan';
export type { RowSecurityRole } from './row-security-role';
export {
  assertRowSecurityBinds,
  rowSecurityExemption,
  rowSecurityRole,
} from './row-security-role';
export {
  APP_ROLE,
  assumeRole,
  ensureRowSecurityRoles,
  MIGRATOR_ROLE,
  rowSecurityRolesSql,
  serveAsAppRole,
} from './row-security-roles';
export { sameTenantKeyName } from './same-tenant';
export { SIBLING_SCOPE_WAIT_MS } from './sibling-turn';
export { snapshotJson } from './snapshot-json';
export { parseSnapshot } from './snapshot-parse';
export type { SqlFragment } from './sql';
export {
  identifier,
  isSqlFragment,
  join,
  literal,
  raw,
  shellInertIdentifier,
  sql,
} from './sql';
export { stripSqlNoise } from './sql-noise';
export { dollarTagAt, endOfBlockComment } from './sql-scan';
export type { DbSqlStateCode } from './sqlstate';
export { DB_SQLSTATE_CODES, isRetryableState, SQLSTATE, sqlState, sqlStateCode } from './sqlstate';
export type { StatementBoundOptions } from './statement-bound';
export { withStatementTimeout } from './statement-bound';
export { statementFingerprint, statementKind, statementVerb } from './statement-shape';
export { STATEMENT_ATTRIBUTE } from './statement-span';
export { statementsOf } from './statement-split';
export {
  completeTransaction,
  currentTx,
  liveTxConnection,
  outsideTransaction,
  withTransaction,
} from './transaction';
export {
  commitUnknown,
  siblingScopeTimeout,
  transactionAborted,
} from './transaction-errors';
export { refuseAbandoned } from './transaction-guard';
export type { DbTx, IsolationLevel, TransactionOptions } from './transaction-options';
export { beginStatement } from './transaction-options';
export { setTransactionSettings, transactionSettings } from './transaction-settings';
export type { GeneratableForm } from './ungeneratable';
export { GENERATABLE_FORMS, ungeneratableStatements } from './ungeneratable';
export type { UnrenderedDeclaration } from './unrendered';
export { unrenderedComment, unrenderedOf } from './unrendered';
