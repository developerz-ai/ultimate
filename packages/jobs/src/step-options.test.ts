// `stepTimeout` and `eventPoll` are DECLARED on the job and reach the step runner, or they do not
// exist. `StepRunnerOptions` carried both, `withStepTimeout` implemented one of them and
// `steps.test.ts` exercised both by constructing a runner BY HAND — while `execute.ts`, the only
// production construction, passed neither and `JobDefinition` had no field that could. A per-step
// ceiling nothing can ask for is the documented-guarantee-that-does-nothing `job.concurrency`
// already had to be rescued from.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, frozenClock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver, NackOptions } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobExecution } from './execute';
import { executeJob } from './execute';
import type { AnyJobHandle, JobDefinition } from './job';
import { job, resetJobs } from './job';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const ctx = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

interface Harness {
  execute(): Promise<JobExecution>;
  nacks(): readonly NackOptions[];
}

/** One declared job, claimed off a memory queue, with every nack the worker would see. */
async function claimOne(
  definition: Omit<JobDefinition<{ n: number }>, 'input' | 'idempotencyKey' | 'tenant' | 'retry'>,
): Promise<Harness> {
  resetJobs();
  const handle = job<{ n: number }>({
    tenant: 'none',
    name: 'stepped',
    input: passthrough<{ n: number }>(),
    idempotencyKey: ({ n }) => `stepped:${n}`,
    retry: { attempts: 3, jitter: false },
    ...definition,
  });
  const base = createMemoryDriver();
  const nacks: NackOptions[] = [];
  const driver: JobDriver = {
    ...base,
    async nack(jobId, nack) {
      nacks.push(nack);
      await base.nack(jobId, nack);
    },
  };
  await driver.enqueue({
    name: 'stepped',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'stepped:1',
    maxAttempts: 3,
  });
  const claimed = (
    await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-test',
    })
  )[0] as ClaimedJob;
  return {
    execute: () =>
      executeJob({
        driver,
        claimed,
        handle: handle as AnyJobHandle,
        ctx: ctx(),
        clock: frozenClock(0),
      }),
    nacks: () => nacks,
  };
}

afterEach(() => {
  resetJobs();
});

describe('the declaration reaches the handle', () => {
  test('stepTimeout and eventPoll are normalised to ms, like timeout', () => {
    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'declared',
      input: passthrough<{ n: number }>(),
      idempotencyKey: () => 'declared',
      retry: { attempts: 1 },
      timeout: '1m',
      stepTimeout: '25s',
      eventPoll: '5s',
      run: () => Promise.resolve(),
    });

    expect(handle.timeoutMs).toBe(60_000);
    expect(handle.stepTimeoutMs).toBe(25_000);
    expect(handle.eventPollMs).toBe(5_000);
  });

  test('a zero ceiling is refused where it is written, not silently ignored', () => {
    // `withStepTimeout` reads `<= 0` as "no ceiling at all", so a declared zero would be a job
    // whose author asked for a limit and got none — the shape `concurrency: 0` is refused in.
    expect(() =>
      job<{ n: number }>({
        tenant: 'none',
        name: 'zeroed',
        input: passthrough<{ n: number }>(),
        idempotencyKey: () => 'zeroed',
        retry: { attempts: 1 },
        stepTimeout: 0,
        run: () => Promise.resolve(),
      }),
    ).toThrow(/stepTimeout/);
  });
});

describe('the per-step ceiling actually stops a step', () => {
  test('a step past its declared ceiling fails the attempt, and the job retries', async () => {
    // Raced against a fallback rather than awaited bare: with the option unreachable this step
    // never settles, and a test that hangs is a test that fails for the wrong reason.
    const harness = await claimOne({
      stepTimeout: '15ms',
      run: ({ step }) =>
        step.run(
          'hang',
          (signal) =>
            new Promise<string>((resolve) => {
              signal.addEventListener('abort', () => resolve('cut'), { once: true });
            }),
        ),
    });

    const outcome = await Promise.race([
      harness.execute(),
      Bun.sleep(400).then(() => 'the step ran past its ceiling forever' as const),
    ]);

    expect(typeof outcome).not.toBe('string');
    const execution = outcome as JobExecution;
    expect(execution.outcome).toBe('retried');
    expect(execution.error).toContain('X_JOB_TIMEOUT');
    // The job's own `timeout` is absent here, so this rejection can only be the step's.
    expect(harness.nacks()[0]?.countsAsAttempt).not.toBe(false);
  });

  test('a step inside the ceiling is untouched', async () => {
    const harness = await claimOne({
      stepTimeout: '5s',
      run: ({ step }) => step.run('quick', () => Promise.resolve('done')),
    });

    expect((await harness.execute()).outcome).toBe('completed');
    expect(harness.nacks()).toEqual([]);
  });
});

describe('the event poll actually paces a waiting step', () => {
  test('a declared eventPoll is how long the run parks, not the 30s default', async () => {
    const harness = await claimOne({
      eventPoll: '1s',
      run: ({ step }) => step.waitForEvent('invoice.paid', { timeout: '1h' }),
    });

    const execution = await harness.execute();

    expect(execution.outcome).toBe('suspended');
    // Exact because the clock is frozen: `resumeAt` is `now + pollMs` and the nack's delay is
    // `resumeAt - now`. Undeclared, this row would have parked for the whole 30 seconds.
    expect(harness.nacks()[0]).toEqual({ delayMs: 1_000, countsAsAttempt: false });
  });
});
