// J7: the run's steps arrive WITH the claim (`ClaimedJob.steps`), so an attempt replays without a
// round trip to list them — on a first attempt too, where the list answered nothing 7,115 times a
// day in production. Through `executeJob`, the one production construction of a runner.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import type { StepStore } from './steps';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

afterEach(() => {
  resetJobs();
});

/** The driver, its step store's `list` counted. */
function listing(): { readonly driver: JobDriver; lists: () => number } {
  const inner = memoryJobDriver();
  let lists = 0;
  const steps: StepStore = {
    ...inner.steps,
    list(runId) {
      lists += 1;
      return inner.steps.list(runId);
    },
  };
  return { driver: { ...inner, steps }, lists: () => lists };
}

describe('steps that ride the claim', () => {
  test('a runner handed the steps never lists them, and replays what they hold', async () => {
    const store = memoryStepStore();
    let lists = 0;
    const counted: StepStore = {
      ...store,
      list(runId) {
        lists += 1;
        return store.list(runId);
      },
    };
    const runner = stepRunner({
      runId: 'run-1',
      jobName: 'claimed',
      store: counted,
      steps: [
        { runId: 'run-1', name: 'a', status: 'completed', output: 7, startedAt: 1, attempts: 1 },
      ],
    });
    let ran = 0;
    const replayed = await runner.step.run('a', () => {
      ran += 1;
      return 0;
    });
    expect(replayed).toBe(7);
    expect(ran).toBe(0);
    expect(lists).toBe(0);
  });

  test('a claimed attempt runs its steps with no list round trip', async () => {
    const { driver, lists } = listing();
    const handle = itemJob({
      async run({ step }) {
        await step.run('one', () => 1);
      },
    });
    await driver.enqueue({
      name: handle.name,
      queue: 'default',
      input: { item: 'x' },
      idempotencyKey: 'claimed:x',
      maxAttempts: 3,
    });
    const [claimed] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    });
    if (claimed === undefined) return expect.unreachable('the row is claimable');
    expect(claimed.steps).toEqual([]);
    const before = lists();
    const execution = await executeJob({
      driver,
      claimed,
      handle,
      ctx: ctxOf({ role: 'worker', buildId: 'test' }),
    });
    expect(execution.error).toBeUndefined();
    expect(execution.outcome).toBe('completed');
    expect(lists() - before).toBe(0);
  });
});
