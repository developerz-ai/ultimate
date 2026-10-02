// The lifecycle and answer scenarios on the memory driver, under an injected clock. The pg half is
// `driver-pg-lifecycle.job.test.ts`: the same scenarios against a real Postgres.

import { afterEach, describe } from 'bun:test';
import { driverAnswerScenarios } from './driver-answers-fixture';
import { driverLifecycleScenarios, memoryHarness } from './driver-lifecycle-fixture';
import { resetJobs } from './job';
import { workerExhaustedScenarios } from './worker-exhausted-fixture';

afterEach(() => {
  resetJobs();
});

describe('how a row ends, on the memory driver', () => {
  driverLifecycleScenarios('memory', memoryHarness());
});

describe('what a driver answers, on the memory driver', () => {
  driverAnswerScenarios('memory', memoryHarness());
});

describe('what the worker does with a burial, on the memory driver', () => {
  workerExhaustedScenarios('memory', memoryHarness());
});
