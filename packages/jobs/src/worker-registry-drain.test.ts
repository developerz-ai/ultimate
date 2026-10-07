// The worker's registry row at the two places the worker itself holds it: the teardown, where a
// `forgetWorker` that never answers must not outlive the drain's budget, and the in-flight list,
// where one job held twice (a lapsed claim, re-claimed by this same worker) stays listed until
// BOTH runs have ended.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Ctx, configureLifecycle, ctxOf, drain, resetLifecycle } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import type { WorkerAnnouncement } from './introspection';
import { job, resetJobs } from './job';
import { jobWorker } from './worker';

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

const passthrough: StandardSchemaV1<unknown, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
  },
};

beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
  resetJobs();
});

/** Real time, bounded: fails rather than hangs when the worker never gets there. */
async function until(condition: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!condition()) {
    if (performance.now() > deadline) expect.unreachable('the condition never became true');
    await Bun.sleep(2);
  }
}

describe('the registry row in the teardown', () => {
  test('a forgetWorker that never answers is abandoned at the drain deadline, and the driver still closes', async () => {
    const base = memoryJobDriver();
    let closed = 0;
    const introspect = base.introspect;
    if (introspect === undefined) return expect.unreachable('the memory driver has a registry');
    const driver: JobDriver = {
      ...base,
      introspect: { ...introspect, forgetWorker: () => new Promise<void>(() => undefined) },
      async close() {
        closed += 1;
        await base.close?.();
      },
    };
    configureLifecycle({ deadlineMs: 80 });
    const worker = jobWorker({ driver, context, pollIntervalMs: 60_000 });
    worker.start();

    await drain('SIGTERM');
    // Core abandons a hook at the deadline whatever it does; what is asked here is whether the
    // worker's OWN teardown got past the row — it sat on `forgetWorker` with the driver open.
    await until(() => closed === 1, 1_000);

    expect(closed).toBe(1);
    expect((await worker.stats()).state).toBe('stopped');
  });
});

describe('the in-flight list of one job held twice', () => {
  test('the id stays listed until the SECOND run ends', async () => {
    const base = memoryJobDriver();
    const introspect = base.introspect;
    if (introspect === undefined) return expect.unreachable('the memory driver has a registry');
    const announced: (readonly string[])[] = [];
    let claims = 0;
    const driver: JobDriver = {
      ...base,
      introspect: {
        ...introspect,
        announceWorker(worker: WorkerAnnouncement, ttlMs: number) {
          announced.push(worker.inFlight);
          return introspect.announceWorker(worker, ttlMs);
        },
      },
      async claim(options) {
        const batch = await base.claim(options);
        claims += batch.length > 0 ? 1 : 0;
        const first = batch[0];
        // The lease lapsed under a body still running, and this worker's next pass took the row
        // again: the same id, the next claim.
        if (first !== undefined) redelivery = { ...first, claim: first.claim + 1 };
        else if (redelivery !== undefined && claims === 1) {
          claims += 1;
          return [redelivery];
        }
        return batch;
      },
    };
    let redelivery: Awaited<ReturnType<JobDriver['claim']>>[number] | undefined;
    const gates: (() => void)[] = [];
    job({
      tenant: 'none',
      name: 'heldTwice',
      input: passthrough,
      idempotencyKey: () => 'held-twice',
      retry: { attempts: 3 },
      run: () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    });
    const ticks: (() => void)[] = [];
    const worker = jobWorker({
      driver,
      context,
      concurrency: 2,
      pollIntervalMs: 5,
      drainOnShutdown: false,
      schedule: (tick) => {
        ticks.push(tick);
        return () => undefined;
      },
    });
    const queued = await base.enqueue({
      name: 'heldTwice',
      queue: 'default',
      input: {},
      idempotencyKey: 'held-twice',
      maxAttempts: 3,
    });
    worker.start();
    try {
      await until(() => gates.length === 2);
      gates[0]?.();
      await until(() => worker.stats !== undefined && announced.length > 0);
      let inFlight = 2;
      await until(() => {
        void worker.stats().then((stats) => {
          inFlight = stats.inFlight;
        });
        return inFlight === 1;
      });
      // The registry's own heartbeat: the first interval armed at start.
      ticks[0]?.();
      await until(() => announced.length >= 2);
      expect(announced.at(-1)).toEqual([queued.id]);
    } finally {
      for (const gate of gates) gate();
      await worker.stop();
    }
  });
});
