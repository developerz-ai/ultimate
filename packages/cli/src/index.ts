// Public API of @ultimat3/cli. Explicit re-exports only: create-ultimate and the test suite build
// on these, and a barrel that re-exports everything would make every internal a compatibility
// promise.

// The CLI's own codes and titles, registered for every process that imports this barrel — the
// gate's registry check (`scripts/verify.ts` → `registeredErrorCodes`) reads the registry, and the
// command modules that used to import `error-codes.ts` on the way load lazily since 22.0.0.
import './error-codes';

/** The app's own API over HTTP — the one table `x dev` and a container both mount. */
export { apiRoutes } from './api-routes';
export type { SourceFile } from './app-boundaries';
export {
  appImportGraph,
  checkAppBoundaries,
  readAppSources,
  resolveSpecifier,
  scanRuntimeImports,
} from './app-boundaries';
export { loadApp } from './app-load';
export { appManifest, writeAppManifest } from './app-manifest';
export { requireAppRoot } from './app-root';
export type { RouteStats } from './budgets';
export { checkBudgets, FRAMEWORK_INLINE_SCRIPTS, FRAMEWORK_SCRIPTS } from './budgets';
export { BUILD_ENTRY, BUILD_TARGETS, readTarget } from './cmd-build';
export { dbCommand } from './cmd-db';
export { planDeploy } from './cmd-deploy';
export { startDev } from './cmd-dev';
export type { DoctorProbe } from './cmd-doctor';
export type { GenerateOptions, Generator } from './cmd-generate';
export { GENERATORS, generate, writeFiles } from './cmd-generate';
export { JOBS_SUBCOMMANDS } from './cmd-jobs';
export { newCommand, planNewApp, writeNewApp } from './cmd-new';
export { PLANNED_COMMANDS, PLANNED_SUBCOMMANDS, plannedSubcommand } from './cmd-planned';
// `shotCommand`, `prCommand` and `ciCommand` are deliberately NOT re-exported here. They reach
// `x` through `registry.ts`, which is the only thing that makes a command exist — and the barrel
// is the surface an APP imports. Exporting them would put the browser driver and the GitHub client
// in the module graph of every app that imports `@ultimat3/cli`, for tools it never calls. The app
// path does not pay for the tool path.
export { renderRouteTable } from './cmd-routes';
export { runVerify, VERIFY_STEPS, verifyCommand, verifyStepNames } from './cmd-verify';
export type { CliCommand } from './command';
export { failed, ok } from './command';
export { acceptCreatedTables } from './db-accept-created';
export type { BranchRow } from './db-branch';
export { BRANCH_SUBCOMMANDS, branchDatabaseName, branchNameOf } from './db-branch';
export type { GeneratedFiles } from './db-generate';
export { generateAppMigration } from './db-generate';
export { QuerySubscribesUnknownError, replicaIdentityTables } from './db-subscribes';
export { dispatch } from './dispatch';
export { checkSourceDrift, reconcileSchemaHash, writeSchemaHash } from './drift';
export { registeredErrorCodes } from './error-catalog';
export type { CliErrorCode } from './error-codes';
export {
  BANNED_PHRASES,
  COMMAND_TOKENS,
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkErrorFixes,
  collectDeclaredCodes,
  documentedCodes,
  fixProblem,
  staticFix,
} from './error-contract';
export { checkErrorCodesThrown } from './error-unthrown';
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
export type { CitationFault, CommandCatalog, FixCitation } from './fix-command';
export {
  citationFault,
  citationProblem,
  citedCommandProblem,
  fixCitations,
  loadCommandCatalog,
} from './fix-command';
export { candidatePaths, scanImports } from './fix-imports';
export type { FixScan } from './fix-scan';
export { scanFixes } from './fix-scan';
export { checkFlagReads } from './flag-reads';
// The framework's own tables, as data. Exported so `scripts/` can read the applier's list without
// re-deriving it — the shape a ratchet over declared-but-never-applied DDL needs.
export { FRAMEWORK_SCHEMA } from './framework-schema';
export type { Guard } from './guards';
export { findingProblem, guardFindings, guardPaths } from './guards';
export { ICON_BASE_PATH, ICON_SOURCE } from './icon-assets';
// The island bundler, and only its entry point. An island is the one module Ultimate ships to a
// browser, so an app has to be able to build one to TEST one — `mountIsland` from
// `@ultimat3/testing` takes this function as its `build` parameter (issue #260). `discoverIslands`,
// `islandBundle`, `writeIslands`, `ISLAND_BASE_PATH` and `ISLAND_GLOB` stay internal: they are
// `x build`'s and `x dev`'s wiring, and every name here is a semver promise forever.
export type { IslandChunk } from './island-bundle';
export { buildIslands } from './island-bundle';
export { JOB_STATES } from './jobs-report';
export { renderJobTable } from './jobs-table';
export { msg } from './messages';
export { DEFAULT_METRICS_PORT, startMetricsEndpoint } from './metrics-endpoint';
export { parseMigrationSql, readMigrations } from './migrations';
export type { CommandResult, Finding, JsonValue } from './output';
export { exitCodeFor, findingFrom, render, renderFinding, renderHuman } from './output';
export type { CommandSpec, FlagSpec, ParsedArgs } from './parse';
export { flagBool, flagList, flagString, GLOBAL_FLAGS, nearest, parseArgs } from './parse';
export type { PrerenderedPage, PrerenderReport } from './prerender';
export { DEFAULT_ORIGIN, isPrerenderable, prerenderSite } from './prerender';
export type { PwaArtifacts } from './pwa-artifacts';
export { loadPwaArtifacts } from './pwa-artifacts';
export { COMMANDS, cliVersion, SPECS } from './registry';
export type { RunningRoles, WebBinding } from './role-start';
export { DEV_BINDING, DEV_ROLES, startRoles } from './role-start';
export { assetRoutes, MEDIA_BASE_PATH } from './runtime-assets';
export { resolveServices } from './runtime-bindings';
export { devHooks } from './runtime-hooks';
export { startQueue } from './runtime-queue';
export { appRoutes, routeDocument } from './runtime-render';
export type { RunningServices } from './runtime-services';
export { startServices } from './runtime-services';
// The drift a hash cannot see, and the composition both the gate step and `x doctor` read.
export { checkMigrationDrift, checkSnapshotDrift } from './schema-drift';
export { FrameworkSchemaFailedError } from './schema-errors';
export type { MigratedApp, ServeOptions } from './serve';
export {
  CONTAINER_BINDING,
  DEFAULT_PORT,
  roleFromEnv,
  runMigrations,
  runRole,
  serveApp,
} from './serve';
export { quoteArg } from './shell-quote';
export type { SiteSettings } from './site-config';
export { loadSiteSettings, publicOrigin } from './site-config';
export type { SiteSeo, SiteSeoOptions } from './site-seo';
export { ROBOTS_PATH, SITEMAP_PATH, siteSeo } from './site-seo';
export { eachSourceFile, isGenerated, isTest, SOURCE_GLOBS } from './source-files';
export type { SkippedRoute, StaticReport } from './static-report';
export { parseStaticReport } from './static-report';
export { filesIn, testArgs } from './test-shards';
export { defaultWorkers } from './test-workers';
export { scanCodeDeclarations, scanCodeFixSites, scanCodes } from './ts-scan';
// The one spelling rule for a `references` entry. Exported because the two gate scripts ask the
// same question this package's `package-shape` step does, and three answers is a duplicate entry.
export { normalizeReferencePath } from './tsconfig-references';
export { readVerifyFloor, skippedSuiteFinding, VERIFY_FLOOR_FILE } from './verify-floor';
export type { HostCheck, StepOutcome, VerifyStep, VerifyStepName } from './verify-step';
export { VERIFY_STEP_NAMES } from './verify-step';
export type { TestType } from './verify-tests';
export { TEST_TYPES } from './verify-tests';
export {
  checkFileSizes,
  checkLockstep,
  checkPackageShape,
  LINE_CEILING,
  PACKAGE_FILES,
  SEMVER,
} from './workspace-checks';
export { writeErrorLine, writeLine } from './write-line';
