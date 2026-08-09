// Public API of @ultimat3/cli. Explicit re-exports only: create-ultimate and the test suite build
// on these, and a barrel that re-exports everything would make every internal a compatibility
// promise.

export type { BoundaryCode, SourceFile } from './app-boundaries';
export {
  BOUNDARY_CODES,
  checkAppBoundaries,
  checkImportRules,
  resolveSpecifier,
  scanRuntimeImports,
} from './app-boundaries';
export type { LoadedApp } from './app-load';
export { loadApp, resetAppLoad } from './app-load';
export type { AppManifest } from './app-manifest';
export { appManifest, readAppManifest, writeAppManifest } from './app-manifest';
export { OPENAPI_FILE, openApiJson } from './app-openapi';
export type { AppRoot } from './app-root';
export { findAppRoot, requireAppRoot, requireBunVersion, versionAtLeast } from './app-root';
export type { BuildStats, RouteStats } from './budgets';
export { BUILD_STATS_FILE, checkBudgets, readBuildStats } from './budgets';
export type { BuildTarget } from './cmd-build';
export { argsFor, BUILD_TARGETS, buildCommand, readTarget } from './cmd-build';
export { branchDatabaseName, branchSql, dbCommand, previewUrl } from './cmd-db';
export type { DeployPlan } from './cmd-deploy';
export { deployCommand, planDeploy } from './cmd-deploy';
export type { DevServer, StartDevOptions } from './cmd-dev';
export { devCommand, startDev } from './cmd-dev';
export type { DoctorProbe } from './cmd-doctor';
export {
  doctorCommand,
  ICON_SOURCE,
  OFFLINE_FALLBACK,
  probeFor,
  runDoctor,
} from './cmd-doctor';
export type { GenerateOptions, Generator } from './cmd-generate';
export { GENERATORS, generate, generateCommand, writeFiles } from './cmd-generate';
export { createHelpCommand, createVersionCommand, renderHelp } from './cmd-help';
export { manifestCommand } from './cmd-manifest';
export type { McpTool } from './cmd-mcp';
export { handleRpc, MCP_TOOLS, mcpCommand } from './cmd-mcp';
export type { NewAppOptions, WrittenApp } from './cmd-new';
export { newCommand, planNewApp, writeNewApp } from './cmd-new';
export { renderRouteTable, routesCommand } from './cmd-routes';
export type { RunShardsOptions, Shard, TestFile } from './cmd-test';
export {
  availableCpus,
  discoverTests,
  planShards,
  reproduceFor,
  runShards,
  shardArgs,
  testCommand,
} from './cmd-test';
export { runVerify, VERIFY_STEPS, verifyCommand, verifyStepNames } from './cmd-verify';
export type { CliCommand, CommandContext } from './command';
export { failed, ok } from './command';
export type { DevServices, Role, ServiceBinding } from './dev-services';
export { describeServices, ROLES, resolveServices, roleContext } from './dev-services';
export type { DispatchOptions } from './dispatch';
export { dispatch } from './dispatch';
export { checkDrift, recordedHashes, schemaHash, writeSchemaHash } from './drift';
export type { CliErrorCode } from './errors';
export {
  BadFlagError,
  BunVersionError,
  CLI_ERROR_CODES,
  CliNotImplementedError,
  NoTestFilesError,
  NotInAppError,
  UnknownCommandError,
  VerifyFailedError,
} from './errors';
export type { ExecOptions, ExecResult, Runner } from './exec';
export { exec, execOutput } from './exec';
export { messageKeys, msg } from './messages';
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
export { CLI_VERSION, COMMANDS, commandFor, SPECS } from './registry';
export type {
  HostCheck,
  StepOutcome,
  VerifyContext,
  VerifyStep,
  VerifyStepName,
} from './verify-step';
export { VERIFY_STEP_NAMES } from './verify-step';
export type { TestType } from './verify-tests';
export { TEST_STEPS, TEST_TYPES, testStepCommand } from './verify-tests';
export {
  checkFileSizes,
  checkPackageShape,
  hasWorkspacePackages,
  LINE_CEILING,
  PACKAGE_FILES,
  workspacePackages,
} from './workspace-checks';
