// Public API of @ultimat3/cli. Explicit re-exports only: create-ultimate and the test suite build
// on these, and a barrel that re-exports everything would make every internal a compatibility
// promise.

/** The app's own API over HTTP — the one table `x dev` and a container both mount. */
export { apiRoutes } from './api-routes';
export type { BoundaryCode, SourceFile } from './app-boundaries';
export {
  appImportGraph,
  BOUNDARY_CODES,
  checkAppBoundaries,
  checkImportRules,
  readAppSources,
  resolveSpecifier,
  scanRuntimeImports,
} from './app-boundaries';
export type { LoadedApp } from './app-load';
export { loadApp, resetAppLoad } from './app-load';
export type { AppManifest } from './app-manifest';
export { appManifest, policyFacts, readAppManifest, writeAppManifest } from './app-manifest';
export { OPENAPI_FILE, openApiJson } from './app-openapi';
export type { AppRoot } from './app-root';
export { findAppRoot, requireAppRoot, requireBunVersion, versionAtLeast } from './app-root';
export type { BoundaryCut, BoundarySplit } from './boundary-cuts';
export { planBoundaryCuts } from './boundary-cuts';
export type { BuildStats, RouteStats } from './budgets';
export { BUILD_STATS_FILE, checkBudgets, readBuildStats } from './budgets';
export type { BuildTarget } from './cmd-build';
export {
  argsFor,
  BUILD_ENTRY,
  BUILD_TARGETS,
  buildCommand,
  readTarget,
  requireEntry,
} from './cmd-build';
export { branchDatabaseName, branchSql, dbCommand, previewUrl } from './cmd-db';
export type { DeployPlan } from './cmd-deploy';
export { deployCommand, planDeploy } from './cmd-deploy';
export type { DevServer, StartDevOptions } from './cmd-dev';
export { devCommand, startDev } from './cmd-dev';
export type { DoctorProbe } from './cmd-doctor';
export { doctorCommand, OFFLINE_FALLBACK, probeFor, runDoctor } from './cmd-doctor';
export { ERRORS_SUBCOMMANDS, errorsCommand } from './cmd-errors';
export { FIX_SUBCOMMANDS, fixCommand } from './cmd-fix';
export type { GenerateOptions, Generator } from './cmd-generate';
export { GENERATORS, generate, generateCommand, writeFiles } from './cmd-generate';
export { createHelpCommand, createVersionCommand, renderHelp } from './cmd-help';
export { buildDrainTarget, JOBS_SUBCOMMANDS, jobsCommand } from './cmd-jobs';
export { manifestCommand } from './cmd-manifest';
export type { McpHttpServer } from './cmd-mcp';
export { mcpCommand, startMcpHttp } from './cmd-mcp';
export type { NewAppOptions, WrittenApp } from './cmd-new';
export { newCommand, planNewApp, writeNewApp } from './cmd-new';
export type { PlannedCommand, PlannedSubcommand } from './cmd-planned';
export {
  PLANNED_COMMANDS,
  PLANNED_SUBCOMMANDS,
  plannedCommands,
  plannedSubcommand,
} from './cmd-planned';
export { actionsCommand, entitiesCommand, queriesCommand } from './cmd-registries';
export { renderRouteTable, routesCommand } from './cmd-routes';
export { testCommand } from './cmd-test';
export { runVerify, VERIFY_STEPS, verifyCommand, verifyStepNames } from './cmd-verify';
export type { CliCommand, CommandContext } from './command';
export { failed, ok } from './command';
export type { GeneratedFiles, GenerateMigrationOptions } from './db-generate';
export { generateAppMigration, migrationSql } from './db-generate';
export type { AssetRoutesOptions } from './dev-assets';
export {
  assetRoutes,
  ICON_BASE_PATH,
  ICON_SOURCE,
  MEDIA_BASE_PATH,
} from './dev-assets';
export type { DevDashboardInput, DevStatus } from './dev-dashboard';
export { devDashboardRoutes, devPanels, devSources } from './dev-dashboard';
export { devHooks } from './dev-hooks';
export type { DevDbClient, RunningQueue } from './dev-queue';
export { startQueue } from './dev-queue';
export type { DevRenderOptions, DevRouteData } from './dev-render';
export { appRoutes, routeDocument } from './dev-render';
export type { RunningRoles, StartRolesOptions, WebBinding } from './dev-roles';
export { DEV_BINDING, DEV_ROLES, selectRoles, startRoles } from './dev-roles';
export type { RunningServices } from './dev-runtime';
export { startServices } from './dev-runtime';
export type { DevServices, ServiceBinding } from './dev-services';
export { describeServices, resolveServices } from './dev-services';
export type { DispatchOptions } from './dispatch';
export { dispatch } from './dispatch';
export { checkSourceDrift, recordedHashes, schemaHash, writeSchemaHash } from './drift';
export type { ErrorCatalog } from './error-catalog';
export {
  buildErrorCatalog,
  CATALOG_PACKAGES,
  loadErrorCatalog,
  registeredErrorCodes,
  resetErrorCatalog,
} from './error-catalog';
export type { CliErrorCode } from './error-codes';
export { CLI_ERROR_CODES, CLI_ERROR_TITLES } from './error-codes';
export {
  BANNED_PHRASES,
  COMMAND_TOKENS,
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkErrorFixes,
  collectDeclaredCodes,
  documentedCodes,
  fixProblem,
  liveCodes,
  RESERVED_HEADING,
  staticFix,
} from './error-contract';
export {
  BadFlagError,
  BuildEntryMissingError,
  BunVersionError,
  CatalogExistsError,
  CliNotImplementedError,
  DeclarationUnknownError,
  ErrorCodeUnknownError,
  FixTargetUnknownError,
  JobUnknownError,
  NoTestFilesError,
  NotInAppError,
  PortInvalidError,
  RoleUnknownError,
  UnknownCommandError,
  VerifyFailedError,
} from './errors';
export type { ExecOptions, ExecResult, Runner } from './exec';
export { exec, execOutput } from './exec';
export type { DrainFailure, DrainOutcome, DrainSkip } from './jobs-drain';
export { drainJobs } from './jobs-drain';
export type { JobsListFilter, JobsListResult } from './jobs-report';
export { JOB_STATES, listJobs, retryJob, showJob } from './jobs-report';
export { renderJobTable } from './jobs-table';
export type { CliMcpServer, DevHostInput } from './mcp-host';
export { createDevMcpServer, DEV_TOOL_SCOPES, localCaller } from './mcp-host';
export { messageKeys, msg } from './messages';
export type { MetricsEndpoint, MetricsEndpointOptions } from './metrics-endpoint';
export { DEFAULT_METRICS_PORT, startMetricsEndpoint } from './metrics-endpoint';
export {
  hashFileName,
  MIGRATIONS_DIR,
  migrationName,
  parseMigrationSql,
  readMigrations,
  snapshotFileName,
} from './migrations';
export type { CommandResult, Finding, JsonValue, StepResult } from './output';
export {
  exitCodeFor,
  findingFrom,
  isUltimateErrorShape,
  render,
  renderFinding,
  renderHuman,
  renderJson,
  renderUltimateError,
} from './output';
export type { CommandSpec, FlagSpec, ParsedArgs } from './parse';
export { flagBool, flagList, flagString, GLOBAL_FLAGS, nearest, parseArgs } from './parse';
export type { PrerenderedPage, PrerenderOptions, PrerenderReport } from './prerender';
export { DEFAULT_ORIGIN, isPrerenderable, prerenderSite } from './prerender';
export { COMMANDS, cliVersion, commandFor, SPECS } from './registry';
export type { MigratedApp, ServedApp, ServeOptions, StartedApp } from './serve';
export {
  CONTAINER_BINDING,
  DEFAULT_PORT,
  metricsPortFromEnv,
  portFromEnv,
  roleFromEnv,
  runMigrations,
  runRole,
  serveApp,
} from './serve';
export {
  eachSourceFile,
  isGenerated,
  isTest,
  isVendored,
  SOURCE_GLOBS,
} from './source-files';
export type { TestFile } from './test-select';
export { belongsToType, discoverTests, sampleFiles } from './test-select';
export type { ReproduceOptions, RunShardsOptions, Shard } from './test-shards';
export { planShards, quoteArg, reproduceFor, runShards, shardArgs } from './test-shards';
export { availableCpus, defaultWorkers, WORKER_CEILING } from './test-workers';
export type { CodeSite, FixSite, SourceSite } from './ts-scan';
export {
  isCodeRegistry,
  maskLiterals,
  scanBorrowedCodes,
  scanCodes,
  scanFixes,
  stripComments,
} from './ts-scan';
export type { VerifyFloor } from './verify-floor';
export {
  floorProblemFindings,
  floorRequires,
  parseVerifyFloor,
  readVerifyFloor,
  VERIFY_FLOOR_FILE,
  vanishedSuiteFinding,
} from './verify-floor';
export type {
  HostCheck,
  StepOutcome,
  VerifyContext,
  VerifyStep,
  VerifyStepName,
} from './verify-step';
export { VERIFY_STEP_NAMES } from './verify-step';
export type { TestType } from './verify-tests';
export { TEST_STEPS, TEST_TYPES, testStepCommand, typeFilterOf } from './verify-tests';
export type { ManifestFacts } from './workspace-checks';
export {
  checkFileSizes,
  checkLockstep,
  checkPackageShape,
  frameworkDepsOf,
  hasWorkspacePackages,
  LINE_CEILING,
  PACKAGE_FILES,
  workspacePackages,
} from './workspace-checks';
