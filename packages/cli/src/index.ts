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
// The raw-CDP browser the driver above runs on. `openE2eBrowserIfAvailable()` is what an app's
// test preload calls: it answers `undefined` on a machine with no Chrome, so the browser-backed
// suite SKIPS rather than turning a gate red for a reason unrelated to the change.
export type { E2eBrowser, OpenE2eBrowserOptions } from './cdp-browser';
export {
  DEFAULT_CDP_TIMEOUT_MS,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from './cdp-browser';
export type { CdpConnection, CdpConnectionOptions, CdpResult } from './cdp-connection';
export { cdpConnect } from './cdp-connection';
export type { CdpE2ePageOptions } from './cdp-e2e-page';
export { cdpE2ePage } from './cdp-e2e-page';
export {
  CdpBrowserMissingError,
  CdpCallFailedError,
  CdpLaunchFailedError,
  CdpTimeoutError,
} from './cdp-errors';
export type { LaunchedBrowser, LaunchOptions } from './cdp-launch';
export {
  CHROME_CANDIDATES,
  CHROME_PATH_ENV,
  findChrome,
  launchChrome,
  launchFoundChrome,
} from './cdp-launch';
export type { BuildTarget } from './cmd-build';
export {
  argsFor,
  BUILD_ENTRY,
  BUILD_TARGETS,
  buildCommand,
  readTarget,
  requireEntry,
} from './cmd-build';
export { dbCommand } from './cmd-db';
export { runBranchCommand } from './cmd-db-branch';
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
// `shotCommand`, `prCommand` and `ciCommand` are deliberately NOT re-exported here. They reach
// `x` through `registry.ts`, which is the only thing that makes a command exist — and the barrel
// is the surface an APP imports. Exporting them puts `cmd-shot.ts` in the module graph of every
// app that imports `@ultimat3/cli`, which then has to resolve `@ultimat3/scraping` — a browser
// driver it never uses. Measured: it reds `tsc -b` on `dummy/social-media-clone` with five
// TS2307s in files that app never calls. The app path does not pay for the tool path.
export { actionsCommand, entitiesCommand, queriesCommand } from './cmd-registries';
export { renderRouteTable, routesCommand } from './cmd-routes';
export { testCommand } from './cmd-test';
export { runVerify, VERIFY_STEPS, verifyCommand, verifyStepNames } from './cmd-verify';
export type { CliCommand, CommandContext } from './command';
export { failed, ok } from './command';
export { acceptCreatedTables, createdTables } from './db-accept-created';
export type { BranchRow, BranchSubcommand } from './db-branch';
export {
  BRANCH_SUBCOMMANDS,
  branchDatabaseName,
  branchNameOf,
  isBranchSubcommand,
  pgliteBranchName,
  previewUrl,
} from './db-branch';
export type { GeneratedFiles, GenerateMigrationOptions, GenerateOutcome } from './db-generate';
export { generateAppMigration, migrationSql } from './db-generate';
export type { SubscribingQuery } from './db-subscribes';
export { QuerySubscribesUnknownError, replicaIdentityTables } from './db-subscribes';
export type { AssetRoutesOptions } from './dev-assets';
export {
  assetRoutes,
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
export type { DeclaredEntityCount, HashReconciliation } from './drift';
export {
  checkSourceDrift,
  reconcileSchemaHash,
  recordedHashes,
  schemaHash,
  writeSchemaHash,
} from './drift';
// The browser-backed e2e driver. `installE2eDriver` is the ONE entry point an app's test preload
// calls; everything below it is exported because the adapter's own pieces are what a driver author
// re-uses, and a deep import into `src/` would make each of them a compatibility promise anyway.
export type { E2eDriverOptions } from './e2e-driver';
export { e2eFixtures, installE2eDriver } from './e2e-driver';
export {
  E2eEvaluateCapturedError,
  E2eEvaluateThrewError,
  E2eEvaluateUnsupportedError,
  E2eLocatorAmbiguousError,
  E2eLocatorEmptyError,
  E2eServiceWorkerAbsentError,
} from './e2e-errors';
export type { EvaluablePage } from './e2e-evaluate';
export { closureSource, evaluateClosure, evaluateExpression } from './e2e-evaluate';
export type { LocatablePage } from './e2e-locator';
export { e2eLocator, resetLocatorMarks } from './e2e-locator';
export type { E2eBrowserPage, E2ePageOptions } from './e2e-page';
export { DEFAULT_E2E_TIMEOUT_MS, DEFAULT_SERVICE_WORKER_TIMEOUT_MS, e2ePage } from './e2e-page';
export type { E2eResolution, E2eSelection } from './e2e-selection';
export {
  MARK_ATTRIBUTE,
  markSelector,
  selectionCall,
  selectionExpression,
  unmarkExpression,
} from './e2e-selection';
export type { ErrorCatalog } from './error-catalog';
export {
  buildErrorCatalog,
  CATALOG_OPTIONAL_HOSTS,
  CATALOG_PACKAGES,
  loadErrorCatalog,
  registeredErrorCodes,
  resetErrorCatalog,
} from './error-catalog';
export type { CliErrorCode } from './error-codes';
export { CLI_ERROR_CODES, CLI_ERROR_TITLES } from './error-codes';
export type { ErrorFixReport } from './error-contract';
export {
  BANNED_PHRASES,
  COMMAND_TOKENS,
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkErrorCodeResolution,
  checkErrorFixes,
  checkErrorFixReport,
  collectDeclaredCodes,
  documentedCodes,
  fixProblem,
  liveCodes,
  RESERVED_HEADING,
  staticFix,
} from './error-contract';
export type { CodeFixIndex, CodeFixScan } from './error-fixes';
export {
  codeFixes,
  codeFixScan,
  loadCodeFixes,
  resetCodeFixes,
  scanScopeFixes,
} from './error-fixes';
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
  MissingPositionalError,
  MissingSubcommandError,
  NoTestFilesError,
  NotInAppError,
  PortInvalidError,
  RoleUnknownError,
  UnknownCommandError,
  VerifyFailedError,
} from './errors';
export type { ExecOptions, ExecResult, Runner } from './exec';
export { exec, execOutput } from './exec';
export {
  defaultFavicon,
  FAVICON_PATH,
  FAVICON_SOURCE,
  faviconResponse,
  faviconRoute,
} from './favicon';
export type { CitationFault, CitationRules, CommandCatalog, FixCitation } from './fix-command';
export {
  citationFault,
  citationProblem,
  citedCommandProblem,
  fixCitations,
  loadCommandCatalog,
} from './fix-command';
export type { HelperResolver } from './fix-imports';
export { candidatePaths, createHelperResolver, scanImports } from './fix-imports';
export {
  CITED_FILE_EXTENSIONS,
  citedPathProblem,
  FILE_TOKEN_PATTERN,
  pathCitations,
} from './fix-path';
export type { FixHelper, FixScan } from './fix-scan';
export { scanFixes, scanFixHelpers, scanFixSites } from './fix-scan';
export type { DeclaredFlag } from './flag-reads';
export { checkFlagReads, declaredFlags, readsFlag } from './flag-reads';
export type { FrameworkSchema, SchemaExecutor } from './framework-schema';
// The framework's own tables, as data. Exported so `scripts/` can read the applier's list without
// re-deriving it — the shape a ratchet over declared-but-never-applied DDL needs.
export {
  applyFrameworkSchema,
  FRAMEWORK_SCHEMA,
  frameworkTableNames,
  schemaStatements,
} from './framework-schema';
export type { Guard } from './guards';
export { findingProblem, GUARD_DIR, guardFindings, guardPaths } from './guards';
export {
  hasSourceIcon,
  ICON_BASE_PATH,
  ICON_SOURCE,
  iconPlan,
  iconRenderer,
} from './icon-assets';
// The island bundler, and only its entry point. An island is the one module Ultimate ships to a
// browser, so an app has to be able to build one to TEST one — `mountIsland` from
// `@ultimat3/testing` takes this function as its `build` parameter (issue #260). `discoverIslands`,
// `islandBundle`, `writeIslands`, `ISLAND_BASE_PATH` and `ISLAND_GLOB` stay internal: they are
// `x build`'s and `x dev`'s wiring, and every name here is a semver promise forever.
export type { IslandBundle, IslandChunk } from './island-bundle';
export { buildIslands } from './island-bundle';
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
export type { PwaArtifacts } from './pwa-artifacts';
export {
  loadPwaArtifacts,
  pwaManifestRoute,
  WEB_MANIFEST_PATH,
  writePwaIcons,
} from './pwa-artifacts';
export { COMMANDS, cliVersion, commandFor, SPECS } from './registry';
export type { SchemaDifference, SchemaDirection, SchemaPart } from './schema-diff';
export { diffDeclaredSchema } from './schema-diff';
// The drift a hash cannot see, and the composition both the gate step and `x doctor` read.
export type { DeclaredEntities } from './schema-drift';
export { checkMigrationDrift, checkSnapshotDrift } from './schema-drift';
export { FrameworkSchemaFailedError } from './schema-errors';
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
export { quoteArg } from './shell-quote';
export {
  eachSourceFile,
  isGenerated,
  isTest,
  isVendored,
  SOURCE_GLOBS,
} from './source-files';
export type {
  EmittedPage,
  RouteFacts,
  SkippedRoute,
  SkipReason,
  StaticReport,
  UnmeasuredRoute,
} from './static-report';
export {
  parseStaticReport,
  readStaticReport,
  removeStaticReport,
  renderStaticReport,
  SKIP_REASONS,
  STATIC_REPORT_FILE,
  skippedRoute,
  skipReasonFor,
  writeStaticReport,
} from './static-report';
export type { TestCounts } from './test-counts';
export { countsOf } from './test-counts';
export type { TestFile } from './test-select';
export { belongsToType, discoverTests, sampleFiles } from './test-select';
export type { ReproduceOptions, RunShardsOptions } from './test-shards';
export { filesIn, reproduceFor, runShards, testArgs } from './test-shards';
export { availableCpus, defaultWorkers, WORKER_CEILING } from './test-workers';
export type {
  CodeFixSite,
  CodeScan,
  CodeSite,
  FixSite,
  SourceSite,
  UnresolvedCodeSite,
} from './ts-scan';
export {
  isCodeRegistry,
  maskLiterals,
  scanBorrowedCodes,
  scanCodeDeclarations,
  scanCodeFixSites,
  scanCodes,
  stripComments,
} from './ts-scan';
// The one spelling rule for a `references` entry. Exported because the two gate scripts ask the
// same question this package's `package-shape` step does, and three answers is a duplicate entry.
export { normalizeReferencePath } from './tsconfig-references';
export type { VerifyFloor } from './verify-floor';
export {
  floorProblemFindings,
  floorRequires,
  parseVerifyFloor,
  readVerifyFloor,
  skippedSuiteFinding,
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
export { TEST_STEPS, TEST_TYPES, testStepCommand, typeFiltersOf } from './verify-tests';
export type { ManifestFacts, PackageShapeOptions } from './workspace-checks';
export {
  checkFileSizes,
  checkLockstep,
  checkPackageShape,
  frameworkDepsOf,
  hasWorkspacePackages,
  LINE_CEILING,
  PACKAGE_FILES,
  SEMVER,
  workspacePackages,
} from './workspace-checks';
export type { WorkspaceNode, WorkspaceScan } from './workspace-graph';
// The graph itself, not just the gate's verdict on it: issue #239's complaint is that a
// scaffolded repo's dependency graph exists only inside `tsc`, so an app's own tooling has
// nothing to read. `checkWorkspaceDependencies` stays internal — it is reached through
// `x verify`, which is the one way a rule is enforced here.
export { readWorkspaceGraph, scanWorkspaces } from './workspace-graph';
export { writeErrorLine, writeLine } from './write-line';
