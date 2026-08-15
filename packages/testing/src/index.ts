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
export type { DeterminismOptions } from './determinism';
export {
  advanceClock,
  assertDeterministic,
  DEFAULT_NOW,
  DEFAULT_SEED,
  frozenClock,
  frozenNow,
  installDeterminism,
  isDeterminismInstalled,
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
export type { JobRunTrace, RunJobs, StepTally } from './fixture-jobs';
export { createRunJobs } from './fixture-jobs';
export type { MailRef, TestMail } from './fixture-mail';
export { createTestMail } from './fixture-mail';
export type { TestNetwork } from './fixture-network';
export { createTestNetwork } from './fixture-network';
export type { ObservedStatement, StatementShape, TestStatements } from './fixture-statements';
export { createTestStatements } from './fixture-statements';
export { fixtureTest as test } from './fixtures';
export {
  ALL_FIXTURE_NAMES,
  DRIVER_FIXTURE_NAMES,
  FRAMEWORK_FIXTURE_NAMES,
  registerFrameworkFixtures,
} from './framework-fixtures';
export type { AppHandle, AppOptions, BootedApp } from './harness';
export { describeApp, testApp } from './harness';
export type { MatcherResult } from './matchers';
export { matchersInstalled, recordSteps } from './matchers';
export type { MockRoute, NetworkState } from './sealed-network';
// `setNetworkState` is deliberately not here: it is the offline gate's one writer, and a test that
// called it directly would bypass the `network` fixture's disposal and leave the whole process
// offline for every file after it. The fixture is the way to go offline — there is no second one.
export {
  allowHost,
  isNetworkSealed,
  mockFetch,
  mockJson,
  networkState,
  requestedUrls,
  resetNetwork,
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
