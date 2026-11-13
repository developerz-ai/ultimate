// The worker's place in the process drain: which PHASE each half of its teardown belongs to, and
// what happens when a job outruns the budget. One `accept` hook that waited for every in-flight job
// spent the whole drain deadline before the second accept hook — the HTTP server's "stop
// listening", the sync node's "stop upgrading" — had been invoked at all, and left the worker
// pinned at 'draining' with its driver open, so a later `stop()` joined a teardown nothing would
// ever finish. Fake time (`fake-time-fixture.ts`) moves the drain's deadline and the body's wait
// alike, so "outran the budget" is a fact of the timers armed, not of a runner's speed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Ctx,
  configureLifecycle,
  ctxOf,
  drain,
  inflightCount,
  isUltimateError,
  onShutdown,
  resetLifecycle,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { useFakeTime } from './fake-time-fixture';
import { job, resetJobs } from './job';
import { jobWorker, type Worker } from './worker';

const time = useFakeTime();

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface Rig {
  readonly worker: Worker;
  closes(): number;
  /** Resolves once the body is inside its sleep — the state every assertion here is about. */
  running(): Promise<void>;
  /** What `ctx.signal.reason` became — heard, never honoured — or `undefined` while it holds. */
  reason(): unknown;
}

/**
 * A worker holding one job that ignores `ctx.signal` and outlives the drain's budget. Nothing in
 * JS can kill such a body, which is exactly why the wait around it has to be bounded.
 */
async function rig(options: { jobMs: number }): Promise<Rig> {
  let closes = 0;
  let reason: unknown;
  let started = (): void => undefined;
  const isRunning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const base = memoryJobDriver();
  const driver: JobDriver = {
    ...base,
    async close(): Promise<void> {
      closes += 1;
      await base.close();
    },
  };
  job<{ n: number }>({
    tenant: 'none',
    name: 'slowJob',
    input: passthrough<{ n: number }>(),
    idempotencyKey: ({ n }) => `slow:${n}`,
    retry: { attempts: 1, jitter: 'none' },
    run: async ({ ctx }) => {
      ctx.signal.addEventListener(
        'abort',
        () => {
          reason = ctx.signal.reason;
        },
        { once: true },
      );
      started();
      await time.sleep(options.jobMs);
    },
  });
  await driver.enqueue({
    name: 'slowJob',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'slow:1',
    maxAttempts: 1,
  });
  const worker = jobWorker({ driver, context, pollIntervalMs: 1 });
  worker.start();
  await time.settles(isRunning, 50);
  return { worker, closes: () => closes, running: () => isRunning, reason: () => reason };
}

beforeEach(() => {
  resetLifecycle();
  resetJobs();
});

afterEach(() => {
  resetLifecycle();
  resetJobs();
});

describe('the worker drains in two phases, and its wait is bounded', () => {
  test('a running job is core in-flight work, not something the accept phase waits for', async () => {
    const app = await rig({ jobMs: 60 });

    // `beginWork()` is what puts a claimed job in the drain's OWN in-flight wait — the phase
    // between `accept` and `inflight` that exists for exactly this. Counted nowhere, the worker
    // had to do the waiting itself, inside a hook, in the phase whose whole job is to be quick.
    expect(inflightCount()).toBe(1);

    await time.settles(app.worker.stop(), 100);
    expect(inflightCount()).toBe(0);
  });

  test('an accept hook behind the worker still gets its turn when a job outruns the budget', async () => {
    configureLifecycle({ deadlineMs: 150 });
    const app = await rig({ jobMs: 600 });

    let acceptedAt = 0;
    // Registered after the worker's, which is where an app's `listen()` and `listenSyncNode()`
    // land: both register an `accept` hook that stops the process taking new work. Behind a hook
    // that waits out a 600ms job under a 150ms budget, neither of them ever ran — the load
    // balancer went on routing to this pod for the whole of the drain it was told about.
    onShutdown(
      'probe:accept',
      async () => {
        await time.sleep(5);
        acceptedAt += 1;
      },
      { phase: 'accept' },
    );

    await time.settles(drain('SIGTERM'), 300);
    // Read the instant the drain returns, not later: an abandoned hook is still RUNNING, so a
    // probe asserted after a sleep would pass either way — it is whether the phase finished
    // inside the drain that decides whether the load balancer was ever told.
    expect(acceptedAt).toBe(1);
    // The close hook is ABANDONED at the deadline — the job is still running and no budget is
    // left — so the teardown behind it finishes on its own clock. What matters is that it
    // finishes: bounded, it closes the driver and reaches 'stopped' instead of parking forever
    // on a body that ignores its signal — well before the 600 ms body ends.
    await time.advance(30);

    expect((await app.worker.stats()).state).toBe('stopped');
    expect(app.closes()).toBe(1);
  });

  test('stop() after an abandoned drain answers rather than joining it forever', async () => {
    configureLifecycle({ deadlineMs: 150 });
    const app = await rig({ jobMs: 600 });

    await time.settles(drain('SIGTERM'), 300);
    await time.advance(30);

    // The memoized teardown is what a second `stop()` joins, and an unbounded one never settles:
    // `x dev`'s role rollback awaits this, so a wedged teardown wedges the shutdown that was
    // supposed to be tearing it down.
    // Inside 250 ms of fake time, and so well before the 600 ms body could release it.
    await time.settles(app.worker.stop('rollback'), 250);
    expect((await app.worker.stats()).state).toBe('stopped');
  });

  test('a SIGTERM landing on a manual stop() binds the teardown to the shutdown deadline', async () => {
    configureLifecycle({ deadlineMs: 150 });
    const app = await rig({ jobMs: 600 });

    // `x dev`'s role rollback, an operator's `worker.stop()` — a manual stop waits as long as its
    // work takes, by design. Then the kubelet sends SIGTERM into the middle of it. The `close`
    // hook JOINS the teardown already in flight, and until 2026-09-07 that teardown kept the
    // `undefined` deadline it was started with: core abandoned the hook at 150ms and moved on,
    // while the worker sat on the 600ms body with its driver open and `stopping` never settling.
    const stopped = app.worker.stop('deploy');
    await time.advance(10);
    await time.settles(drain('SIGTERM'), 300);

    // The abort is the accept hook's and fires either way; what the join was missing is the bound.
    const reason = app.reason();
    if (!isUltimateError(reason)) {
      expect.unreachable(`ctx.signal.reason was ${String(reason)}, not an UltimateError`);
    }
    expect(reason.code).toBe('X_DRAINING');

    // Well inside the 600ms the body still has to run: the teardown adopted the 150ms deadline,
    // abandoned the body there, closed the driver and answered the manual caller.
    await time.settles(stopped, 200);
    expect((await app.worker.stats()).state).toBe('stopped');
    expect(app.closes()).toBe(1);
  });
});
