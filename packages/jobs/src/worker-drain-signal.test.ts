// The drain's cut-off reaches the job. Until 2026-09-07 the drain told nobody, so a body reading
// `ctx.signal` — the documented way to stop early — ran to the deadline and was abandoned there.
// Until 2026-10-05 it told everybody AT SIGTERM, cancelling work the budget could have finished.
// Now the job is told at `deadlineAt − margin` (`worker-drain-cutoff.ts`): late enough to finish
// what fits, early enough to unwind and hand the row back before the deadline.
//
// The cut-off is armed by the ACCEPT hook and not the close one: core's drain runs `accept`, then
// waits out in-flight work (a claimed job is `beginWork()`ed) under the same budget, then `close`.
// Armed in `close`, the job would hear it after the in-flight wait had already spent everything.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Ctx,
  configureLifecycle,
  createContext,
  drain,
  isUltimateError,
  resetLifecycle,
  systemClock,
  throwIfAborted,
  UltimateError,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver, NackOptions, QueueStats } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker, type Worker } from './worker';

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

/** Resolves once `signal` aborts — the shape of a body that stops when it is told to. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

interface Rig {
  readonly worker: Worker;
  readonly driver: JobDriver;
  /** Every `nack` the driver received, in order. */
  readonly nacks: NackOptions[];
  /** What `ctx.signal.reason` was when the body observed its abort — `undefined` until then. */
  reason(): unknown;
  /** The default queue as the driver reported it the instant the teardown closed it. */
  queueAtClose(): QueueStats | undefined;
}

/**
 * A worker running one job whose body waits for its signal and then does what `after` says.
 * `attempts: 1` on purpose: a failure here dead-letters, so "not dead" is a discriminating
 * assertion rather than a retry that would have happened anyway.
 */
async function rig(after: (ctx: Ctx) => void | Promise<void>): Promise<Rig> {
  let reason: unknown;
  let started = (): void => undefined;
  const isRunning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const nacks: NackOptions[] = [];
  let queueAtClose: QueueStats | undefined;
  const base = memoryJobDriver();
  const driver: JobDriver = {
    ...base,
    async nack(jobId: string, options: NackOptions): Promise<boolean> {
      nacks.push(options);
      return base.nack(jobId, options);
    },
    // Read BEFORE the close: the memory driver holds nothing past it, and the teardown closes the
    // driver — so "what did the queue hold when this worker let go" is only answerable here.
    async close(): Promise<void> {
      [queueAtClose] = await base.stats();
      await base.close();
    },
  };
  job<{ n: number }>({
    tenant: 'none',
    name: 'signalledJob',
    input: passthrough<{ n: number }>(),
    idempotencyKey: ({ n }) => `signalled:${n}`,
    retry: { attempts: 1, jitter: false },
    run: async ({ ctx }) => {
      started();
      await aborted(ctx.signal);
      reason = ctx.signal.reason;
      await after(ctx);
    },
  });
  await driver.enqueue({
    name: 'signalledJob',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'signalled:1',
    maxAttempts: 1,
  });
  const worker = createWorker({ driver, context, pollIntervalMs: 1, workerId: 'w-drain' });
  worker.start();
  await isRunning;
  return { worker, driver, nacks, reason: () => reason, queueAtClose: () => queueAtClose };
}

/** Small, so the cut-off — half of it, for a budget this size — lands inside a test's patience. */
const DEADLINE_MS = 300;

beforeEach(() => {
  resetLifecycle();
  configureLifecycle({ deadlineMs: DEADLINE_MS });
  resetJobs();
});

afterEach(() => {
  resetLifecycle();
  resetJobs();
});

describe('the cut-off aborts the signal of every job the worker still holds', () => {
  test('a body that stops when told is told at the cut-off and finishes before the deadline', async () => {
    const app = await rig(() => undefined);

    const startedAt = systemClock.monotonic();
    await drain('SIGTERM');
    const tookMs = systemClock.monotonic() - startedAt;

    // Told at SIGTERM it would be cut short at once: the cut-off is never EARLY, because a timer
    // only ever fires late, so this lower bound holds on any machine. There is no upper bound on
    // the wall clock — a loaded CI runner measured 325.8 ms against the 300 ms budget (#663) — and
    // none is needed: "finished, not abandoned at the deadline" is `processed: 1` below, since an
    // abandoned run is handed back and never counted.
    expect(tookMs).toBeGreaterThanOrEqual(DEADLINE_MS / 2 - 5);
    const stats = await app.worker.stats();
    expect(stats.state).toBe('stopped');
    expect(stats.processed).toBe(1);
  });

  test('the reason names the drain: X_DRAINING, the worker and the signal', async () => {
    const app = await rig(() => undefined);

    await drain('SIGTERM');

    const reason = app.reason();
    if (!isUltimateError(reason)) {
      expect.unreachable(`ctx.signal.reason was ${String(reason)}, not an UltimateError`);
    }
    expect(reason.code).toBe('X_DRAINING');
    expect(reason.cause).toContain('w-drain');
    expect(reason.cause).toContain('SIGTERM');
  });

  test('a body that unwinds on the signal is interrupted: re-queued, attempt uncounted', async () => {
    const app = await rig((ctx) => {
      throwIfAborted(ctx);
    });

    await drain('SIGTERM');

    // `countsAsAttempt: false` is the whole of "retryable, not failed": with `attempts: 1` the
    // ordinary failure path would have dead-lettered a job the process, not the job, cut short.
    expect(app.nacks).toHaveLength(1);
    expect(app.nacks[0]?.countsAsAttempt).toBe(false);
    expect(app.nacks[0]?.deadLetter).not.toBe(true);
    expect(app.nacks[0]?.park).not.toBe(true);
    expect(app.nacks[0]?.delayMs).toBe(0);
    expect(app.queueAtClose()?.ready).toBe(1);
    expect(app.queueAtClose()?.dead).toBe(0);

    const stats = await app.worker.stats();
    expect(stats.interrupted).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.deadLettered).toBe(0);
  });

  test('a body that fails with its OWN error once told is interrupted too', async () => {
    // What a killed child looks like from inside the job: the ssh wrapper's coded error, not the
    // signal's reason. The framework said stop, so whatever the body stopped WITH is the
    // framework's doing — an attempt burned per deploy is the "always twice" draining exists to
    // prevent, one layer down.
    const app = await rig(() => {
      throw new UltimateError({
        code: 'X_DRIVER_UNAVAILABLE',
        cause: 'ssh exited 255: killed by the shutdown signal',
        fix: 'none — the job is re-queued',
      });
    });

    await drain('SIGTERM');

    expect(app.nacks[0]?.countsAsAttempt).toBe(false);
    expect((await app.worker.stats()).interrupted).toBe(1);
    expect(app.queueAtClose()?.dead).toBe(0);
    expect(app.queueAtClose()?.ready).toBe(1);
  });

  test('a manual stop() tells nobody — it waits for the job it holds', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let told = false;
    let started = (): void => undefined;
    const isRunning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const driver = memoryJobDriver();
    job<{ n: number }>({
      tenant: 'none',
      name: 'heldJob',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `held:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async ({ ctx }) => {
        started();
        await held;
        told = ctx.signal.aborted;
      },
    });
    await driver.enqueue({
      name: 'heldJob',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: 'held:1',
      maxAttempts: 1,
    });
    const worker = createWorker({ driver, context, pollIntervalMs: 1 });
    worker.start();
    await isRunning;

    // A caller that asked has no budget to spend and wants its work finished — the bound and the
    // abort both belong to the SIGTERM path, where the budget is real.
    const stopped = worker.stop('deploy');
    await Bun.sleep(10);
    release();
    await stopped;

    expect(told).toBe(false);
    expect((await worker.stats()).processed).toBe(1);
  });

  test('a restarted worker hands its jobs a fresh signal, not the one the last drain fired', async () => {
    const app = await rig(() => undefined);
    await drain('SIGTERM');
    resetLifecycle();

    let signalAtStart: boolean | undefined;
    let started = (): void => undefined;
    const isRunning = new Promise<void>((resolve) => {
      started = resolve;
    });
    resetJobs();
    job<{ n: number }>({
      tenant: 'none',
      name: 'secondJob',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `second:${n}`,
      retry: { attempts: 1, jitter: false },
      run: ({ ctx }) => {
        signalAtStart = ctx.signal.aborted;
        started();
        return Promise.resolve();
      },
    });
    await app.driver.enqueue({
      name: 'secondJob',
      queue: 'default',
      input: { n: 2 },
      idempotencyKey: 'second:2',
      maxAttempts: 1,
    });

    app.worker.start();
    await isRunning;
    await app.worker.stop();

    // A controller aborted once stays aborted: reused, every job the restarted worker claimed
    // would have been born cancelled.
    expect(signalAtStart).toBe(false);
  });
});
