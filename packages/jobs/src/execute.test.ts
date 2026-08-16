// The deadline is a cancellation, not just a rejection. What is proven here is the ORDER — the
// body is told to stop before the nack that hands its job to another worker — and the fence that
// holds when the body ignores it: a step from the timed-out attempt never reaches the store.

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver, NackOptions } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobExecution } from './execute';
import { executeJob } from './execute';
import type { AnyJobHandle, JobRunArgs } from './job';
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

/**
 * Poll, never sleep a guessed interval: every wait below is for an ABANDONED body — work the
 * deadline already gave up on — and a fixed sleep sized against it inverts on a loaded runner,
 * failing for scheduling rather than for the behaviour under test.
 */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 2) {
    if (condition()) return;
    await Bun.sleep(2);
  }
  throw new Error(`until timed out: ${label}`);
}

interface Harness {
  readonly driver: JobDriver;
  readonly claimed: ClaimedJob;
  execute(ctx?: Ctx): Promise<JobExecution>;
  nacks(): readonly NackOptions[];
}

/** One job on a memory queue, claimed, with every `nack` observable as the worker would make it. */
async function claimOne(
  options: {
    readonly timeout?: string;
    /** Fails settlement the way a pool timeout does: the body already ran, `ack` did not land. */
    readonly ackFails?: () => Error;
    run(args: JobRunArgs<{ n: number }>): Promise<unknown>;
  },
  onNack?: (nack: NackOptions) => void,
): Promise<Harness> {
  resetJobs();
  const handle = job<{ n: number }>({
    tenant: 'none',
    name: 'cancellable',
    input: passthrough<{ n: number }>(),
    idempotencyKey: ({ n }) => `cancellable:${n}`,
    retry: { attempts: 3, jitter: false },
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    run: options.run,
  });
  const base = createMemoryDriver();
  const nacks: NackOptions[] = [];
  const driver: JobDriver = {
    ...base,
    async ack(jobId) {
      const failure = options.ackFails?.();
      if (failure !== undefined) throw failure;
      await base.ack(jobId);
    },
    async nack(jobId, nack) {
      nacks.push(nack);
      onNack?.(nack);
      await base.nack(jobId, nack);
    },
  };
  await driver.enqueue({
    name: 'cancellable',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'cancellable:1',
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
    driver,
    claimed,
    execute: (ctx = createContext({ role: 'worker', buildId: 'test' })) =>
      executeJob({ driver, claimed, handle: handle as AnyJobHandle, ctx }),
    nacks: () => nacks,
  };
}

afterAll(() => {
  resetJobs();
});

describe('a timed-out job is cancelled, not orphaned', () => {
  test('the body sees ctx.signal aborted, and sees it BEFORE the job is re-queued', async () => {
    let abortedInBody: boolean | undefined;
    let abortedAtNack: boolean | undefined;
    let bodySignal: AbortSignal | undefined;
    const harness = await claimOne(
      {
        timeout: '5ms',
        run: async ({ ctx }) => {
          bodySignal = ctx.signal;
          await Bun.sleep(40);
          abortedInBody = ctx.signal.aborted;
        },
      },
      () => {
        abortedAtNack = bodySignal?.aborted;
      },
    );

    const execution = await harness.execute();

    expect(execution.outcome).toBe('retried');
    expect(execution.error).toContain('X_JOB_TIMEOUT');
    // The nack makes the job claimable by another worker, so the body must already have been told
    // to stop by the time it happens — otherwise two copies of one job run side by side.
    expect(abortedAtNack).toBe(true);
    await until(() => abortedInBody !== undefined, 'the abandoned body finished');
    expect(abortedInBody).toBe(true);
  });

  test('a step the timed-out body finishes anyway is refused, not written', async () => {
    let late: Promise<unknown> | undefined;
    const harness = await claimOne({
      timeout: '5ms',
      // The uncooperative handler: it never reads the signal and finishes its work late.
      run: ({ step }) => {
        late = step.run('late', () => Bun.sleep(40).then(() => 'done'));
        return late;
      },
    });

    await harness.execute();
    // The step's own promise is the deterministic signal that its late write was reached and
    // refused — a sleep sized against the 40ms body would race it on a loaded runner.
    await expect(late).rejects.toThrow(/X_ABORTED/);

    // Neither a `completed` record the retry would replay as already-done, nor a `failed` one
    // written over whatever the attempt that replaced this one has put there.
    expect(await harness.driver.steps.get(harness.claimed.runId, 'late')).toBeUndefined();
  });

  test('the run settling ends the attempt, so a step left in flight cannot write either', async () => {
    let forgotten: Promise<unknown> | undefined;
    const harness = await claimOne({
      run: ({ step }) => {
        // A handler that does not await its own step: the run returns, the step keeps going.
        forgotten = step.run('forgotten', () => Bun.sleep(20).then(() => 'done'));
        return Promise.resolve();
      },
    });

    const execution = await harness.execute();

    expect(execution.outcome).toBe('completed');
    await expect(forgotten).rejects.toThrow(/X_ABORTED/);
    expect(await harness.driver.steps.get(harness.claimed.runId, 'forgotten')).toBeUndefined();
  });

  test('a body that runs past its deadline is named in the log', async () => {
    const warn = spyOn(logger, 'warn');
    const harness = await claimOne({ timeout: '5ms', run: () => Bun.sleep(40) });

    await harness.execute();
    await until(
      () => warn.mock.calls.some((call) => call[0] === 'jobs.timeout.abandoned'),
      'jobs.timeout.abandoned logged',
    );
    const abandoned = warn.mock.calls.find((call) => call[0] === 'jobs.timeout.abandoned');
    warn.mockRestore();

    expect(abandoned?.[1]).toMatchObject({ job: 'cancellable', ended: 'resolved' });
  });

  test('a body that stops when cancelled is the intended end, and stays out of the log', async () => {
    const warn = spyOn(logger, 'warn');
    const harness = await claimOne({
      timeout: '5ms',
      // The cooperative handler: it watches the signal and unwinds when it fires.
      run: ({ ctx }) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 40);
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(ctx.signal.reason as Error);
            },
            { once: true },
          );
        }),
    });

    await harness.execute();
    // The one wait here that must stay fixed: this asserts an ABSENCE, so there is no condition
    // to poll for. The bound covers the 40ms at which an uncooperative body would have logged.
    await Bun.sleep(60);
    const abandoned = warn.mock.calls.filter((call) => call[0] === 'jobs.timeout.abandoned');
    warn.mockRestore();

    expect(abandoned).toEqual([]);
  });

  test('a caller whose ctx was already going away gets no step history', async () => {
    const gone = new AbortController();
    gone.abort();
    let ran = false;
    const harness = await claimOne({
      run: ({ step }) =>
        step.run('never', () => {
          ran = true;
          return 'x';
        }),
    });

    const execution = await harness.execute(
      createContext({ role: 'worker', buildId: 'test', signal: gone.signal }),
    );

    // The step body still runs — only a write can be fenced — but the attempt fails with the
    // cancellation instead of recording history for a run it no longer owns.
    expect(ran).toBe(true);
    expect(execution.error).toContain('X_ABORTED');
    expect(await harness.driver.steps.get(harness.claimed.runId, 'never')).toBeUndefined();
  });

  test('a ctx that arrived across a cast without a signal still runs', async () => {
    const harness = await claimOne({ run: ({ step }) => step.run('quick', () => 'ok') });

    // `@ultimat3/http`'s `asCtx` casts a request context into a `Ctx` without one, so the field
    // the type promises is not always there. A job must not crash on that.
    const execution = await harness.execute({ signal: undefined } as unknown as Ctx);

    expect(execution.outcome).toBe('completed');
  });

  test('an ack that fails is a settlement failure, never a retry of finished work', async () => {
    let ran = 0;
    const harness = await claimOne({
      ackFails: () => new Error('connection reset'),
      run: async ({ step }) => {
        ran += 1;
        await step.run('charge', () => 'ok');
      },
    });

    // The body ran to completion, so the queue must NOT be told the attempt failed: a nack here
    // re-delivers work whose side effects outside a step already happened, and reports the run as
    // `retried` — a failure `jobs_total{outcome}` would count that never occurred. The worker
    // observes this rejection as `jobs.worker.settle-failed` and the lapsed lease re-delivers.
    await expect(harness.execute()).rejects.toThrow('connection reset');

    expect(ran).toBe(1);
    expect(harness.nacks()).toEqual([]);
    // The step still stands: settlement failed, the work did not.
    expect(await harness.driver.steps.get(harness.claimed.runId, 'charge')).toMatchObject({
      status: 'completed',
    });
  });

  test('a job inside its timeout is untouched by any of this', async () => {
    const harness = await claimOne({
      timeout: '5s',
      run: async ({ step, ctx }) => {
        expect(ctx.signal.aborted).toBe(false);
        await step.run('quick', () => 'ok');
      },
    });

    const execution = await harness.execute();

    expect(execution.outcome).toBe('completed');
    expect(harness.nacks()).toEqual([]);
    expect(await harness.driver.steps.get(harness.claimed.runId, 'quick')).toMatchObject({
      status: 'completed',
      output: 'ok',
    });
  });
});
