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
    run(args: JobRunArgs<{ n: number }>): Promise<unknown>;
  },
  onNack?: (nack: NackOptions) => void,
): Promise<Harness> {
  resetJobs();
  const handle = job<{ n: number }>({
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
    await Bun.sleep(60);
    expect(abortedInBody).toBe(true);
  });

  test('a step the timed-out body finishes anyway is refused, not written', async () => {
    const harness = await claimOne({
      timeout: '5ms',
      // The uncooperative handler: it never reads the signal and finishes its work late.
      run: ({ step }) => step.run('late', () => Bun.sleep(40).then(() => 'done')),
    });

    await harness.execute();
    await Bun.sleep(60);

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
    await Bun.sleep(60);
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
