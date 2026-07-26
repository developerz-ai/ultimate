export type { FixtureBody, FixtureFactory, FixtureMap, Fixtures } from './fixtures';
export {
  clearFixtures,
  defineFixtures,
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
  NetworkSealedError,
  NondeterministicError,
  TESTING_ERROR_CODES,
  TestDatabaseUnavailableError,
} from './errors';
export type { EntityLike, EntityRegistry, Factory, FactoryOptions } from './factories';
export { defineFactory, factoriesFor } from './factories';
export { fixtureTest as test } from './fixtures';
export type { AppHandle, AppOptions, BootedApp } from './harness';
export { describeApp, testApp } from './harness';
export type { MatcherResult } from './matchers';
export { matchersInstalled, recordSteps } from './matchers';
export type { MockRoute } from './sealed-network';
export {
  allowHost,
  mockFetch,
  mockJson,
  requestedUrls,
  resetNetwork,
  sealNetwork,
  unsealNetwork,
} from './sealed-network';
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
  OpenApiLike,
  PageLike,
  TestType,
} from './test-types';
export {
  contractTest,
  e2eTest,
  evalTest,
  jobTest,
  liveTest,
  SEPARATOR,
  TEST_TYPES,
  testName,
  unitTest,
  useE2eDriver,
} from './test-types';
