// The step-store suite over the memory driver's steps, and the proof it can fail: a store that
// drops the fence on the floor (the bare `memoryStepStore()` handed out as a driver's), and one
// that keeps a live reference instead of what JSON carries.

import { describe, expect, test } from 'bun:test';
import type { StepStore } from '@ultimat3/jobs';
import { memoryJobDriver, memoryStepStore } from '@ultimat3/jobs';
import { behavesLike } from './shared-examples';
import type { StepStoreSubject } from './step-store-conformance';
import { STEP_STORE_CHECKS, stepStoreConformance } from './step-store-conformance';
import { testName } from './test-types';

describe(testName('unit', 'the memory driver step store'), () => {
  behavesLike(stepStoreConformance, () => memoryJobDriver());
});

/** The memory driver, its step store swapped for one that does not fence. */
const unfenced = (): StepStoreSubject => ({ ...memoryJobDriver(), steps: memoryStepStore() });

/** A store that holds what it was handed, by reference: a `Date` replays as a `Date`. */
const byReference = (): StepStoreSubject => {
  const records = new Map<string, Parameters<StepStore['put']>[0]>();
  const at = (runId: string, name: string) => `${runId}\u0000${name}`;
  const steps: StepStore = {
    ...memoryStepStore(),
    get: (runId, name) => Promise.resolve(records.get(at(runId, name))),
    put(record) {
      records.set(at(record.runId, record.name), record);
      return Promise.resolve();
    },
  };
  return { ...memoryJobDriver(), steps };
};

const check = (prefix: string) =>
  STEP_STORE_CHECKS.find((each) => each.name.startsWith(prefix)) ??
  expect.unreachable(`no step-store check named ${prefix}`);

describe(testName('unit', 'a store that breaks the step contract fails conformance'), () => {
  test('a store that ignores the fence lands a stale write', async () => {
    await check('a write under a claim that still').run(unfenced());
    await expect(check('a write under another claim').run(unfenced())).rejects.toThrow();
    await expect(check('a write under a claim whose row').run(unfenced())).rejects.toThrow();
  });

  test('a store that keeps a live reference replays a Date', async () => {
    await expect(check('an output is stored').run(byReference())).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = STEP_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
