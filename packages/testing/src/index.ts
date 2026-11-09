export type {
  FixtureBody,
  FixtureFactory,
  FixtureMap,
  FixtureRegistration,
  Fixtures,
} from './fixtures';
export {
  clearFixtures,
  defineFixtures,
  fixtureSnapshot,
  fixtureTest,
  registeredFixtures,
  requestedFixtures,
} from './fixtures';
// Public API of @ultimat3/testing. Explicit re-exports: the preload has its own entry point so a
// bunfig can load side effects without importing the whole harness.

// Re-exported so an app test has one import line instead of two, and so `expect` carries
// this package's custom matchers (`toBeUltimateError`, `toEmitSteps`, …) already installed.
// Importing `expect` straight from `bun:test` in an app test gets the matchers only if some
// other module happened to load first — a load-order dependency, which is a flake.
// `test` is OURS (fixture-injecting); everything else passes through. Re-exported so an app
// test has one import line, and so `expect` carries this package's matchers already installed.
export { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'bun:test';
// The two arguments `hooks.authenticate` is handed, for a test of an app's own authenticator.
// `@ultimat3/http` is imported inside the function.
export type { AuthRequestInit } from './auth-request';
export { authRequest } from './auth-request';
// The accessibility audit every `e2eTest` runs (plan 101 / 39): the one reader of the browser's
// tree, its rules, and the reasoned per-test `allow`.
export type { AxNode, AxTreeNode } from './ax-node';
export { toAxNode, toAxTreeNodes } from './ax-node';
export type { BudgetStoreLike } from './budget-store-conformance';
export { budgetStoreConformance } from './budget-store-conformance';
// Recorded vendor answers, replayed through `mockFetch` with the network sealed; recorded only by
// hand (`ULTIMATE_CASSETTE=record`, never under CI), with the written bytes scanned for secrets.
export type { Cassette, CassetteOptions } from './cassette';
export { CASSETTE_ENV, cassette } from './cassette';
export type { RecordRefusal, UnusedEntry } from './cassette-errors';
export {
  CassetteMissingError,
  CassetteRecordRefusedError,
  CassetteSecretError,
  CassetteUnusedError,
} from './cassette-errors';
export type { CassetteEntry, CassetteFile } from './cassette-format';
// The browser-backed e2e driver and the raw-CDP browser under it — moved here from
// `@ultimat3/cli` in 22.0.0. `installE2eDriver` is the ONE entry point an app's test preload calls;
// `openE2eBrowserIfAvailable()` answers `undefined` on a machine with no Chrome, so a
// browser-backed suite SKIPS rather than turning a gate red. RAW CDP over Bun's own `WebSocket`:
// no dependency, and no `@ultimat3/scraping` / `puppeteer-core` behind it.
export type { E2eBrowser, OpenE2eBrowserOptions } from './cdp-browser';
export {
  DEFAULT_CDP_TIMEOUT_MS,
  E2E_BROWSER_CLOSE_MS,
  E2E_BROWSER_OPEN_MS,
  E2E_GOTO_MS,
  E2E_TAB_OPEN_MS,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from './cdp-browser';
export type { E2eBrowserLease, RunEndHook } from './cdp-browser-lease';
export { closeE2eBrowsersAtRunEnd, leaseE2eBrowser } from './cdp-browser-lease';
export type {
  CdpConnection,
  CdpConnectionOptions,
  CdpEventListener,
  CdpResult,
  CdpTransport,
} from './cdp-connection';
export { cdpConnect, cdpConnectOver } from './cdp-connection';
export type { CdpE2eTabOptions, E2eTab } from './cdp-e2e-page';
export { cdpE2eTab } from './cdp-e2e-page';
export type { CdpE2eSessionOptions, E2eSession } from './cdp-e2e-session';
export { cdpE2eSession } from './cdp-e2e-session';
export type {
  CdpLaunchAttempt,
  CdpTargetGone,
  CdpTimeoutObservation,
  CdpTimeoutReading,
} from './cdp-errors';
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
  CONTAINER_CHROME_ARGS,
  findChrome,
  LAUNCH_ATTEMPTS,
  LAUNCH_BUDGET_MS,
  LAUNCH_TIMEOUT_MS,
  launchChrome,
  launchFoundChrome,
} from './cdp-launch';
// The exercise pass (plan 101 / 40, phase 2): an app's per-primitive overrides — 39's
// `.contract({ exercise })` option, one shape — and the pass over every action, query and job.
export type { ExerciseAppOptions, ExerciseOverride, ExerciseOverrides } from './define-exercise';
export { defineExercise } from './define-exercise';
// The island-state vocabulary. Pure data by design: a `*.island.states.ts` file is read by the
// command that photographs the states, by the harness page and by a guard test — none of which has
// a bundler, and only one of which has a browser.
export { defineIslandStates } from './define-island-states';
export type { DeterminismOptions, DeterminismSnapshot } from './determinism';
// `captureDeterminism` + `restoreCapturedDeterminism` are the pair a NESTED install needs;
// `restoreDeterminism` uninstalls outright and hands the real clock and the real `Math.random`
// back to every later file in the process, which is only ever what the process itself wants.
export {
  advanceClock,
  assertDeterministic,
  captureDeterminism,
  DEFAULT_NOW,
  DEFAULT_SEED,
  frozenNow,
  installDeterminism,
  isDeterminismInstalled,
  restoreCapturedDeterminism,
  restoreDeterminism,
  seededRandom,
  seededUuid,
  setFrozenClock,
  withFrozenClock,
} from './determinism';
// `x drill` (plan 101 / 40): the eight fault drills, the fleet they run on, the verdict over evidence.
export type { DrillConfig, DrillTiming } from './drill-budgets';
export { drillBudgets } from './drill-budgets';
export { DrillFailedError, DrillServiceMissingError } from './drill-errors';
export type { DrillFleet, DrillRoleProcess, DrillServiceUrls } from './drill-fleet';
export { startDrillFleet } from './drill-fleet';
export { bunDrillSql } from './drill-jobs';
export type { DrillTarget } from './drill-load';
export type { DrillReport } from './drill-run';
export { runDrill } from './drill-run';
export type { DrillDeclarations } from './drill-services';
export { DRILL_SERVICE_ENV, drillServices } from './drill-services';
export type { DrillSyncEvidence, DrillSyncLane, DrillSyncOptions } from './drill-sync';
export { startDrillSync } from './drill-sync';
export type { DrillBudgets, DrillEvidence, DrillFailure, DrillProperty } from './drill-verdict';
export { judgeDrill } from './drill-verdict';
export type { DrillWriteCandidate, DrillWrites } from './drill-writes';
export { DRILL_DRAW_SEED, drillWriteTargets } from './drill-writes';
export type { Drill, DrillName, DrillRole, DrillService } from './drills';
export { DRILL_NAMES, DRILLS, drillNamed, drillRoles } from './drills';
export type { A11yFinding, A11yRule } from './e2e-a11y';
export { auditTree, NAMED_ROLES } from './e2e-a11y';
export type { A11yAllow, A11yOptions } from './e2e-a11y-run';
export {
  E2eA11yAllowUnreasonedError,
  E2eA11yUnavailableError,
  E2eA11yViolationError,
} from './e2e-a11y-run';
export { allowA11y } from './e2e-a11y-tabs';
export type { E2eApp, E2eAppMode, StartE2eAppOptions } from './e2e-app';
export { E2E_APP_START_MS, E2E_APP_STOP_MS, startE2eApp } from './e2e-app';
export { E2E_ROOT_ENV, e2eApp, e2eBaseUrl, e2eBrowser } from './e2e-browser-handle';
export type { E2eDriverOptions } from './e2e-driver';
export { e2eFixtures, installE2eDriver } from './e2e-driver';
export type { E2eErrorCode } from './e2e-error-codes';
export { E2E_ERROR_CODES, E2E_ERROR_TITLES } from './e2e-error-codes';
export {
  E2eAppFailedError,
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
export type { AxTreeRequest, E2eBrowserPage, E2ePageOptions } from './e2e-page';
export { DEFAULT_E2E_TIMEOUT_MS, DEFAULT_SERVICE_WORKER_TIMEOUT_MS, e2ePage } from './e2e-page';
export type { E2eResolution, E2eSelection } from './e2e-selection';
export {
  MARK_ATTRIBUTE,
  markSelector,
  selectionCall,
  selectionExpression,
  unmarkExpression,
} from './e2e-selection';
export type { TestingErrorCode } from './errors';
export {
  AppNotBootedError,
  FixtureUnavailableError,
  NetworkOfflineError,
  NetworkSealedError,
  NondeterministicError,
  RegistryLeakError,
  TESTING_ERROR_CODES,
  TESTING_ERROR_TITLES,
  TestDatabaseUnavailableError,
} from './errors';
export type { ExercisePassOptions } from './exercise';
export { runExercisePass } from './exercise';
export type { ActorChoice, RoleGrants } from './exercise-actor';
export type { ExerciseDefect } from './exercise-defect';
export {
  type OverrideActor,
  type OverrideHint,
  overrideLine,
  UNBOUND_ID,
} from './exercise-override-line';
export type {
  CrashFinding,
  CrashProof,
  EffectPayload,
  ExerciseEffect,
  ExerciseOutcome,
  ExercisePhaseMs,
  ExerciseRecord,
  ProofMs,
  TenantFinding,
  TenantLeg,
  TenantProof,
} from './exercise-report';
export type { ExerciseSetup, ExerciseSetupHandle } from './exercise-setup';
export type {
  Association,
  AssociationMap,
  EntityLike,
  Factory,
  FactoryIds,
  FactoryOptions,
  Trait,
  TraitMap,
} from './factories';
export { associate, defineFactory, seedFor } from './factories';
export type { Persister } from './factory-persist';
export { clearPersister, persisterInstalled, usePersister } from './factory-persist';
export type { EntityRegistry, FactoryRegistry } from './factory-registry';
export { factoriesFor } from './factory-registry';
export type {
  FakeIdentityProvider,
  FakeIdentityProviderInput,
  FakeIdpTamper,
  FakeIdpUser,
} from './fake-identity-provider';
export { fakeIdentityProvider } from './fake-identity-provider';
export type { FaultMode, FaultProxy, FaultProxyCounts } from './fault-proxy';
export { faultProxy, throughFaultProxy } from './fault-proxy';
export type { TestClock, TestDuration } from './fixture-clock';
export { testClock } from './fixture-clock';
export type {
  DriverFixtureName,
  DriverFixtures,
  LiveFeed,
  LiveFeedPatch,
  LiveTarget,
  SignIn,
  Subscribe,
  TestBudget,
  TestDeploy,
} from './fixture-drivers';
export { DRIVER_FIXTURE_NEEDS, driverFixtures, unavailableFixture } from './fixture-drivers';
// The island fixture. `build` is a PARAMETER — `buildIslands` lives in `@ultimat3/cli`, which is
// tier 5 like this package and whose one declared edge points the other way, so an app supplies it:
// `mountIsland({ build: buildIslands, root, file })`.
export type {
  IslandBuilder,
  IslandBundleLike,
  IslandChunkLike,
  MountedIsland,
  MountIslandOptions,
  SharedChunkLike,
} from './fixture-island';
export { mountIsland } from './fixture-island';
export type {
  JobDrainAs,
  JobEnqueueAs,
  JobRunTrace,
  RunJobs,
  RunJobsOptions,
  StepTally,
} from './fixture-jobs';
export { testJobs } from './fixture-jobs';
export type { MailRef, TestMail } from './fixture-mail';
export { testMail } from './fixture-mail';
export type { TestNetwork } from './fixture-network';
export { testNetwork } from './fixture-network';
export type { TestPush, TestPushMessage } from './fixture-push';
export { testPush } from './fixture-push';
export type { ObservedStatement, StatementShape, TestStatements } from './fixture-statements';
export { testStatements } from './fixture-statements';
export type { SubscribeDriver } from './fixture-subscribe';
export { subscribeDriver } from './fixture-subscribe';
export { fixtureTest as test } from './fixtures';
export {
  ALL_FIXTURE_NAMES,
  DRIVER_FIXTURE_NAMES,
  FRAMEWORK_FIXTURE_NAMES,
  registerFrameworkFixtures,
} from './framework-fixtures';
export type { AppHandle, AppOptions, BootedApp } from './harness';
export { describeApp, testApp } from './harness';
// Type-only: the micro-DOM is the fixture's to build, and a test only ever names what it handed back.
export type { FakeElement, FakeNode, FakeText } from './island-dom';
export type { FakeResizeObserverEntry, ResizeInput, ResizeRect } from './island-observers';
export type { IslandAddress, IslandShotTarget } from './island-shot-targets';
export {
  isIslandTheme,
  islandAddress,
  islandShotFile,
  islandShotPlan,
  islandShotTargets,
  parseIslandAddress,
} from './island-shot-targets';
// The file an error tells the reader to edit — the island's own name with `.states.ts` where
// `.tsx` was. Exported so the command that takes the pictures names the same file the refusal does.
export { islandStatesFile } from './island-state-errors';
// One declared state, mounted: `describeIslandState` owns a block's mount and teardown,
// `mountIslandState` is the one mount a single test asks for with `using`.
export type { IslandStateMountOptions, IslandStateSuiteOptions } from './island-state-mount';
export {
  describeIslandState,
  ISLAND_MOUNT_TIMEOUT_MS,
  mountIslandState,
} from './island-state-mount';
export type {
  IslandRouteStub,
  IslandState,
  IslandStateDecl,
  IslandStatesDecl,
  IslandStatesManifest,
  IslandStubResponse,
  IslandTheme,
  IslandViewport,
} from './island-states';
export {
  DEFAULT_ISLAND_THEME,
  DEFAULT_ISLAND_VIEWPORT,
  ISLAND_SHOT_TIME_ZONE,
  ISLAND_STATES,
  ISLAND_THEMES,
  isIslandStatesManifest,
  islandStatesName,
} from './island-states';
export type { JsonFault } from './island-states-check';
export {
  isPinnedInstant,
  isStateId,
  isStubMatch,
  isTimeZone,
  jsonFault,
  slugifyStateId,
} from './island-states-check';
export type {
  IslandFaultKind,
  IslandStatesFault,
  ModuleEdge,
} from './island-states-pure';
export {
  assertIslandStatesPure,
  importSpecifiers,
  impureSpecifier,
  islandStatesFault,
  islandStatesImportFault,
  moduleEdges,
} from './island-states-pure';
export {
  assertIslandFiles,
  assertUniqueIslandStates,
  findIslandStates,
  islandStatesMatching,
  islandStatesNames,
  missingIslandFiles,
  normalizeIslandName,
} from './island-states-resolve';
export { ISOLATED_ENV, releasePluginsAfterIsolatedFile } from './isolated-plugins';
export { CRASH_POINT_BOUND } from './job-crash-points';
export type {
  CrashBoundary,
  CrashDivergence,
  CrashProofOptions,
  CrashReport,
  CrashRerun,
} from './job-crash-proof';
export { crashProof } from './job-crash-proof';
export { jobDriverConformance } from './job-driver-conformance';
export type { SimEffect } from './job-sim-effects';
export {
  crashEffectPlace,
  JobCrashDivergedError,
  JobCrashUnboundedError,
  JobSimInvariantError,
  JobSimNondeterministicError,
} from './job-sim-errors';
export type { JobFaultKind } from './job-sim-schedule';
export { ALL_FAULTS, JOB_FAULT_KINDS } from './job-sim-schedule';
export type {
  SimulatedJob,
  SimulatedRun,
  SimulateJobsOptions,
  SimulationReport,
  SimulationState,
} from './job-simulate';
export { JOB_SIM_SEED_ENV, simulateJobs } from './job-simulate';
export type { LiveConnection, LiveNodeHandle, LiveNodeOptions } from './live-node';
export { liveNode } from './live-node';
// The store a mutator's `local()` half writes into under test — the Map every app hand-rolled.
export type { LocalRows, MemoryLocalTx } from './local-tx';
export { memoryLocalTx } from './local-tx';
/**
 * The budget `toBeVisible(options?)` takes. Exported because it is in a public matcher's signature;
 * `retryUntil` and `RetryBudget` deliberately are NOT — nothing outside this package calls them,
 * and an export nothing calls is the unwired declaration this matcher exists to have closed.
 */
export type { VisibleOptions } from './matcher-visible';
export type { MatcherResult } from './matchers';
export { matchersInstalled, recordSteps } from './matchers';
export type { MockHandler, MockRoute } from './mock-route';
// The plan and scale sweeps (plan 101 / 40-next-query-plans): every statement the pass sent planned
// with no index but the declared ones, every reached primitive again at 2 and 8 rows a table.
export type { PlanTableColumns, PlanVerdict, PlanVerdictCode } from './plan-oracle';
export { judgePlan, planRoot } from './plan-oracle';
export type { PlanExempt, PlanProof, SentStatement } from './plan-sweep';
export { QueryPlanUnavailableError, sweepPlans } from './plan-sweep';
export type { PlanFinding } from './plan-sweep-fix';
export { planFindings } from './plan-sweep-fix';
export type { SweepFinding } from './plan-sweep-report';
export { planSweepFindings, planSweepLines } from './plan-sweep-report';
// `isolateEntityRegistry` is deliberately NOT here — it is `@ultimat3/testing/registry-isolation`.
// This barrel is what a `packages/core` test imports for `expect` alone, and a static re-export
// evaluates the module it names: that one would load `@ultimat3/entity` and its process-global
// registry into every test in the framework. Every other package this harness touches is imported
// dynamically inside the fixture that needs it; a helper that must stay synchronous cannot do that,
// so it gets its own entry point instead.
export type { RegistryLeak, RegistrySample } from './registry-leak-guard';
export { installRegistryLeakGuard, leakBetween, sampleRegistries } from './registry-leak-guard';
export type { ProcessRegistrySnapshot } from './registry-snapshot';
export { captureProcessRegistries, restoreProcessRegistries } from './registry-snapshot';
// What the server renders, for a unit test. `@ultimat3/render` is imported inside the two
// functions, so a tier-0 test importing this barrel for `expect` still loads no renderer.
export type { RenderedRoute, RenderedView, RouteModule, RouteRequest } from './render-view';
export { renderRoute, renderView } from './render-view';
// What a test `x repro --write` generated calls: a captured request or a dead job, replayed.
export type { JobFailure, ReproduceOptions, ReproOutcome } from './repro';
export { reproduce, reproJob } from './repro';
export type { LoggedRequest } from './request-log';
export type { DatabaseSnapshot } from './reusable-database';
export { restoreDatabase, reusableDatabase, snapshotDatabase } from './reusable-database';
export type { ScaleProof, ScaleShape, StatementTally } from './scale-sweep';
export { judgeScale, SCALE_SIZES } from './scale-sweep';
export type { NetworkSnapshot, NetworkState } from './sealed-network';
// `setNetworkState` is deliberately not here: it is the offline gate's one writer, and a test that
// called it directly would bypass the `network` fixture's disposal and leave the whole process
// offline for every file after it. The fixture is the way to go offline — there is no second one.
export {
  allowHost,
  captureNetwork,
  isNetworkSealed,
  MOCKED_HOST_ADDRESS,
  mockFetch,
  mockJson,
  networkState,
  requestLog,
  resetNetwork,
  restoreCapturedNetwork,
  sealNetwork,
  unsealNetwork,
} from './sealed-network';
// Rows for every table with no factory written (plan 101 / 40, phase 1): parents first, same-tenant
// keys, values off each column's declaration. Types only from `@ultimat3/entity`, so no registry.
export { seedGraph } from './seed-graph';
export type { SeedGraphUnsatisfiedInput } from './seed-graph-error';
// A seed graph written through each entity's own repository — a pinned client (Postgres, PGlite) or
// the app's driver (memory, `testDriver()`). Loads `@ultimat3/entity` on its first write, not here.
export { SeedGraphEntityUnknownError, SeedGraphUnsatisfiedError } from './seed-graph-error';
export type {
  SeedCanary,
  SeedFactory,
  SeedGraph,
  SeedGraphOptions,
  SeedRow,
  SeedUpdate,
  SeedWriter,
} from './seed-graph-plan';
export { insertSeedGraph } from './seed-graph-plan';
export type { SeedEntity } from './seed-graph-shape';
export type { SeedColumn } from './seed-graph-values';
export type { EntitySeedWriterOptions, SeedWriterTarget } from './seed-writer';
export { entitySeedWriter } from './seed-writer';
export type { SharedExamples } from './shared-examples';
export { behavesLike, sharedExamples } from './shared-examples';
export type { SubjectProofOptions, SubjectProofResult } from './subject-proof';
export { subjectProof } from './subject-proof';
export { SubjectEraseIncompleteError } from './subject-proof-error';
export type {
  DisposableWorkerDatabase,
  SqlRunner,
  TemplateDbConfig,
  WorkerDatabase,
} from './template-db';
export {
  acquireWorkerDatabase,
  cloneSql,
  DEFAULT_TEMPLATE,
  databaseNameFor,
  dropSql,
  lockSql,
  templateSql,
  unlockSql,
  urlFor,
  workerId,
} from './template-db';
// The tenant proof's dynamic legs (plan 101 / 40): B with A's ids, A, B again. The report builders
// are what `x exercise` prints; `tenancy:cross` is `@ultimat3/entity`'s `CROSS_TENANT_SCOPE`.
export type { TenantProofFinding } from './tenant-proof-report';
export { tenantFindingLines, tenantProofFindings } from './tenant-proof-report';
export { paced, TEST_PACE_ENV, TestPaceInvalidError, testPace } from './test-pace';
// `x exercise` is a test process too: it hands itself the same key, judged by the same rule.
export { testSealKeyEnv } from './test-seal-key';
export type {
  E2eBody,
  E2eDriver,
  E2eFixtures,
  E2eTestOptions,
  EvalCase,
  EvalOptions,
  LocatorLike,
  OpenApiLike,
  PageLike,
  TestOptions,
  TestType,
} from './test-types';
export {
  contractTest,
  e2eTest,
  evalTest,
  hasE2eDriver,
  jobTest,
  liveTest,
  resetE2eDriver,
  SEPARATOR,
  TEST_TYPES,
  testName,
  unitTest,
  useE2eDriver,
} from './test-types';
