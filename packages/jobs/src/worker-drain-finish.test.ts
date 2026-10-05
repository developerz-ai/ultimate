// A deploy never cancels work in flight: on SIGTERM the worker stops CLAIMING at once, and the jobs
// it already holds keep running inside the drain budget. Until 2026-10-05 the stop-accepting step
// aborted every held run's `ctx.signal` the instant the signal landed, and a step whose side
// effect completed during the drain was refused by the runner and run again by the next worker —
// a charge made twice on every deploy. Only at `deadlineAt − margin` is what is still running cut
// short, and what is still held after that goes back to the queue at once (no visibility wait).

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
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { AckOptions, JobDriver, NackOptions, QueueStats } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

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

/** Sleeps `ms`, or rejects with the signal's reason the moment it aborts — a cooperative body. */
const sleepUnless = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

interface Recorded {
  readonly driver: JobDriver;
  readonly acks: AckOptions[];
  /** Whether each ack LANDED — a stale claimer's call is made and must be fenced out. */
  readonly landed: { readonly workerId: string; readonly ok: boolean }[];
  readonly nacks: NackOptions[];
  /** The default queue the instant the teardown closed the driver. */
  queueAtClose(): QueueStats | undefined;
}

/**
 * The memory driver, every settle recorded. `close` keeps the store open, so a SECOND worker can
 * ask the same queue what the first one left behind — the question D3 is about.
 */
/** Yields to the event loop until `done()` holds — ordered on the work, never on a clock. */
async function waitUntil(done: () => boolean): Promise<void> {
  for (let turns = 0; !done(); turns += 1) {
    if (turns > 10_000) expect.unreachable('the condition never held');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function recorded(): Recorded {
  const base = createMemoryDriver();
  const acks: AckOptions[] = [];
  const landed: { workerId: string; ok: boolean }[] = [];
  const nacks: NackOptions[] = [];
  let atClose: QueueStats | undefined;
  const driver: JobDriver = {
    ...base,
    async ack(jobId: string, options: AckOptions): Promise<boolean> {
      acks.push(options);
      const ok = await base.ack(jobId, options);
      landed.push({ workerId: options.workerId, ok });
      return ok;
    },
    async nack(jobId: string, options: NackOptions): Promise<boolean> {
      nacks.push(options);
      return base.nack(jobId, options);
    },
    async close(): Promise<void> {
      [atClose] = await base.stats();
    },
  };
  return { driver, acks, landed, nacks, queueAtClose: () => atClose };
}

async function enqueueOne(driver: JobDriver, name: string): Promise<void> {
  await driver.enqueue({
    name,
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: `${name}:1`,
    maxAttempts: 1,
  });
}

/** A promise opened by hand, and a second one telling the test the body reached it. */
function latch(): { readonly reached: Promise<void>; arrive(): void } {
  let arrive = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return { reached, arrive: () => arrive() };
}

beforeEach(() => {
  resetLifecycle();
  resetJobs();
});

afterEach(() => {
  resetLifecycle();
  resetJobs();
});

describe('SIGTERM stops claiming and lets running jobs finish', () => {
  test('a step completing 10 ms after SIGTERM is recorded once and the job is acked', async () => {
    configureLifecycle({ deadlineMs: 2_000 });
    const rec = recorded();
    const started = latch();
    const release = latch();
    let effects = 0;
    let runId = '';
    job<{ n: number }>({
      tenant: 'none',
      name: 'chargeCard',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `chargeCard:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async ({ step, runId: id }) => {
        runId = id;
        await step.run('charge', async () => {
          started.arrive();
          await release.reached;
          effects += 1;
          return 'charged';
        });
      },
    });
    await enqueueOne(rec.driver, 'chargeCard');
    const worker = createWorker({ driver: rec.driver, context, pollIntervalMs: 1 });
    worker.start();
    await started.reached;

    const drained = drain('SIGTERM');
    await Bun.sleep(10);
    release.arrive();
    await drained;

    // Before the fix: the drain aborted the run at SIGTERM, `put` refused the step the side effect
    // had already happened for, and the attempt went back to the queue — the next worker charged
    // the card again.
    expect(effects).toBe(1);
    const steps = await rec.driver.steps.list(runId);
    expect(steps.map((record) => [record.name, record.status, record.attempts])).toEqual([
      ['charge', 'completed', 1],
    ]);
    expect(rec.nacks).toHaveLength(0);
    expect(rec.acks).toHaveLength(1);
    expect(rec.queueAtClose()?.ready).toBe(0);
    expect((await worker.stats()).processed).toBe(1);
  });

  test('a job that reads ctx.signal and finishes inside the budget is acked, not interrupted', async () => {
    configureLifecycle({ deadlineMs: 2_000 });
    const rec = recorded();
    const started = latch();
    let told: boolean | undefined;
    job<{ n: number }>({
      tenant: 'none',
      name: 'cooperative',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `cooperative:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async ({ ctx }) => {
        started.arrive();
        await sleepUnless(80, ctx.signal).catch(() => undefined);
        told = ctx.signal.aborted;
        throwIfAborted(ctx);
      },
    });
    await enqueueOne(rec.driver, 'cooperative');
    const worker = createWorker({ driver: rec.driver, context, pollIntervalMs: 1 });
    worker.start();
    await started.reached;

    const startedAt = systemClock.monotonic();
    await drain('SIGTERM');

    // Told nothing: 80 ms of work inside a 2 s budget is work this process can finish.
    expect(told).toBe(false);
    expect(rec.acks).toHaveLength(1);
    expect(rec.nacks).toHaveLength(0);
    const stats = await worker.stats();
    expect(stats.processed).toBe(1);
    expect(stats.interrupted).toBe(0);
    // And the drain did not sit out the budget once the job was done.
    expect(systemClock.monotonic() - startedAt).toBeLessThan(1_000);
  });

  test('a job still running at deadline − margin is cancelled with X_DRAINING and handed back', async () => {
    configureLifecycle({ deadlineMs: 300 });
    const rec = recorded();
    const started = latch();
    let heardAfterMs: number | undefined;
    let reason: unknown;
    let drainStartedAt = 0;
    job<{ n: number }>({
      tenant: 'none',
      name: 'longRunning',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `longRunning:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async ({ ctx }) => {
        started.arrive();
        try {
          await sleepUnless(5_000, ctx.signal);
        } finally {
          heardAfterMs = systemClock.monotonic() - drainStartedAt;
          reason = ctx.signal.reason;
        }
      },
    });
    await enqueueOne(rec.driver, 'longRunning');
    const worker = createWorker({ driver: rec.driver, context, pollIntervalMs: 1 });
    worker.start();
    await started.reached;

    drainStartedAt = systemClock.monotonic();
    await drain('SIGTERM');

    // Not at SIGTERM — the old behaviour, ~0 ms — but near the end of the budget, still inside it.
    expect(heardAfterMs).toBeGreaterThanOrEqual(100);
    expect(heardAfterMs).toBeLessThan(300);
    if (!isUltimateError(reason)) expect.unreachable(`reason was ${String(reason)}`);
    expect(reason.code).toBe('X_DRAINING');
    // Handed back uncounted, claimable at once, never dead-lettered on its only attempt.
    expect(rec.nacks).toHaveLength(1);
    expect(rec.nacks[0]?.countsAsAttempt).toBe(false);
    expect(rec.nacks[0]?.delayMs).toBe(0);
    expect(rec.queueAtClose()?.ready).toBe(1);
    expect(rec.queueAtClose()?.dead).toBe(0);
    expect((await worker.stats()).interrupted).toBe(1);
  });
});

describe('a claim still held at the cut-off goes back to the queue before the driver closes', () => {
  test('a second worker claims it at once — not after the visibility timeout', async () => {
    configureLifecycle({ deadlineMs: 200 });
    const rec = recorded();
    const started = latch();
    const finish = latch();
    job<{ n: number }>({
      tenant: 'none',
      name: 'deaf',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `deaf:${n}`,
      retry: { attempts: 1, jitter: false },
      // Ignores ctx.signal: nothing in JS can stop it, so only the hand-back frees its row.
      run: async () => {
        started.arrive();
        await finish.reached;
      },
    });
    await enqueueOne(rec.driver, 'deaf');
    const first = createWorker({
      driver: rec.driver,
      context,
      pollIntervalMs: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w-old',
    });
    first.start();
    await started.reached;

    await drain('SIGTERM');

    // Before the fix the row stayed `running` under w-old's 30 s lease: the replacement pod found
    // nothing to claim and the job waited out the whole visibility window.
    expect(rec.nacks.map((nack) => nack.countsAsAttempt)).toEqual([false]);
    expect(rec.queueAtClose()?.ready).toBe(1);
    expect((await first.stats()).state).toBe('stopped');

    resetLifecycle();
    const second = createWorker({
      driver: rec.driver,
      context,
      pollIntervalMs: 1,
      drainOnShutdown: false,
      workerId: 'w-new',
    });
    const claimedAgain = latch();
    resetJobs();
    job<{ n: number }>({
      tenant: 'none',
      name: 'deaf',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `deaf:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async ({ attempt }) => {
        expect(attempt).toBe(1);
        claimedAgain.arrive();
      },
    });
    const executions = await second.tick();
    expect(executions.map((execution) => execution.outcome)).toEqual(['completed']);
    await claimedAgain.reached;

    // The abandoned body ends; its ack is fenced out — the row is w-new's verdict now.
    finish.arrive();
    // Its settle is attempted — nothing can stop a body that ignores ctx.signal — and must not land.
    await waitUntil(() => rec.landed.some((one) => one.workerId === 'w-old'));
    expect(rec.landed.filter((one) => one.workerId === 'w-old')).toEqual([
      { workerId: 'w-old', ok: false },
    ]);
  });
});

describe('a worker started inside a drain claims nothing', () => {
  test('the boot that finished after SIGTERM leaves its worker idle, and stop() still answers', async () => {
    const rec = recorded();
    let ran = 0;
    job<{ n: number }>({
      tenant: 'none',
      name: 'lateBoot',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `lateBoot:${n}`,
      retry: { attempts: 1, jitter: false },
      run: async () => {
        ran += 1;
      },
    });
    await enqueueOne(rec.driver, 'lateBoot');
    await drain('SIGTERM');

    // `startRoles` reaching `worker.start()` after the signal: the shutdown hooks it would register
    // never run — the drain is past them — so a worker that claimed here held jobs nothing drains.
    const worker = createWorker({ driver: rec.driver, context, pollIntervalMs: 1 });
    worker.start();
    await Bun.sleep(30);

    expect(ran).toBe(0);
    expect((await worker.stats()).state).not.toBe('running');
    await worker.stop();
    expect((await rec.driver.stats())[0]?.ready).toBe(1);
  });
});
