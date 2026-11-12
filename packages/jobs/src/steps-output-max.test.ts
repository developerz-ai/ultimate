// `job({ stepOutputMax })` reaches the step runner the worker builds: a declared ceiling that only a
// hand-built `stepRunner` honoured would be a feature no job can use (`execute.ts` threads it).

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ctxOf, logger } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';

afterEach(() => {
  resetJobs();
  mock.restore();
});

/** Each run's step is its own name: the default's warning is once per job and step, per process. */
let runs = 0;

async function runOnce(declared: { stepOutputMax?: number }, bytes: number) {
  runs += 1;
  const handle = job<{ n: number }>({
    tenant: 'none',
    name: 'exporter',
    input: t.object({ n: t.number }),
    idempotencyKey: ({ n }) => `exporter:${n}`,
    retry: { attempts: 3 },
    ...declared,
    run: async ({ step }) => {
      await step.run(`page-${runs}`, () => 'x'.repeat(bytes - 2));
    },
  });
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: 'exporter',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'exporter:1',
    maxAttempts: 3,
  });
  const [claimed] = await driver.claim({
    queues: ['default'],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'worker-test',
  });
  return executeJob({
    driver,
    claimed: claimed as ClaimedJob,
    handle: handle as AnyJobHandle,
    ctx: ctxOf({ role: 'worker', buildId: 'test' }),
  });
}

describe('job({ stepOutputMax })', () => {
  test('a declared ceiling refuses an output the default would take, on the first attempt', async () => {
    const execution = await runOnce({ stepOutputMax: 1_024 }, 2_048);
    expect(execution.code).toBe('X_STEP_OUTPUT_TOO_LARGE');
    expect(execution.outcome).toBe('dead-lettered');
  });

  test('a raised ceiling takes an output past the default', async () => {
    const execution = await runOnce({ stepOutputMax: 512 * 1_024 }, 300 * 1_024);
    expect(execution.outcome).toBe('completed');
  });

  test('omitted, the default ceiling warns and the run completes (refusal is opt-in on main)', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect((await runOnce({}, 300 * 1_024)).outcome).toBe('completed');
    expect(warn.mock.calls.map(([event]) => event)).toContain('jobs.step.output-too-large');
  });

  test('a ceiling that is not a whole number of bytes is refused at declaration', () => {
    expect(() =>
      job({
        tenant: 'none',
        name: 'bad',
        input: t.object({}),
        idempotencyKey: () => 'k',
        retry: { attempts: 1 },
        stepOutputMax: 0,
        run: async () => {},
      }),
    ).toThrow('stepOutputMax');
  });
});
