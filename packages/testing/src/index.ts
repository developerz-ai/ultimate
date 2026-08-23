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
  frozenClock,
  frozenNow,
  installDeterminism,
  isDeterminismInstalled,
  restoreCapturedDeterminism,
  restoreDeterminism,
  seededRandom,
  seededUuid,
  setFrozenClock,
} from './determinism';
export type { TestingErrorCode } from './errors';
export {
  FixtureUnavailableError,
  NetworkOfflineError,
  NetworkSealedError,
  NondeterministicError,
  RegistryLeakError,
  TESTING_ERROR_CODES,
  TESTING_ERROR_TITLES,
  TestDatabaseUnavailableError,
} from './errors';
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
export type { TestClock, TestDuration } from './fixture-clock';
export { createTestClock } from './fixture-clock';
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
} from './fixture-island';
export { mountIsland } from './fixture-island';
export type { JobRunTrace, RunJobs, StepTally } from './fixture-jobs';
export { createRunJobs } from './fixture-jobs';
export type { MailRef, TestMail } from './fixture-mail';
export { createTestMail } from './fixture-mail';
export type { TestNetwork } from './fixture-network';
export { createTestNetwork } from './fixture-network';
export type { ObservedStatement, StatementShape, TestStatements } from './fixture-statements';
export { createTestStatements } from './fixture-statements';
export type { SubscribeDriver } from './fixture-subscribe';
export { createSubscribeDriver } from './fixture-subscribe';
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
export type { LiveConnection, LiveNodeHandle, LiveNodeOptions } from './live-node';
export { createLiveNode } from './live-node';
export type { LiveReplicator, LiveReplicatorOptions } from './live-replicator';
export { startLiveReplicator } from './live-replicator';
export type { MatcherResult } from './matchers';
export { matchersInstalled, recordSteps } from './matchers';
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
export type { MockRoute, NetworkSnapshot, NetworkState } from './sealed-network';
// `setNetworkState` is deliberately not here: it is the offline gate's one writer, and a test that
// called it directly would bypass the `network` fixture's disposal and leave the whole process
// offline for every file after it. The fixture is the way to go offline — there is no second one.
export {
  allowHost,
  captureNetwork,
  isNetworkSealed,
  mockFetch,
  mockJson,
  networkState,
  requestedUrls,
  resetNetwork,
  restoreCapturedNetwork,
  sealNetwork,
  unsealNetwork,
} from './sealed-network';
export type { SharedExamples } from './shared-examples';
export { behavesLike, sharedExamples } from './shared-examples';
export type { SqlRunner, TemplateDbConfig, WorkerDatabase } from './template-db';
export {
  acquireWorkerDatabase,
  cloneSql,
  createTemplateSql,
  DEFAULT_TEMPLATE,
  databaseNameFor,
  dropSql,
  lockSql,
  unlockSql,
  urlFor,
  workerId,
} from './template-db';
export type {
  E2eBody,
  E2eFixtures,
  EvalCase,
  EvalOptions,
  LocatorLike,
  OpenApiLike,
  PageLike,
  TestType,
} from './test-types';
export {
  contractTest,
  e2eTest,
  evalTest,
  hasE2eDriver,
  jobTest,
  liveTest,
  SEPARATOR,
  TEST_TYPES,
  testName,
  unitTest,
  useE2eDriver,
} from './test-types';
