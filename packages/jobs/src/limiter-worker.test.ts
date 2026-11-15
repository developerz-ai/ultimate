// A named limiter as the WORKER runs it: the concurrency slot renews on the worker's own schedule
// and TTL (its visibility timeout), never a private wall-clock interval — under a frozen clock a
// slot renewed by nothing lapsed and admitted a second holder under `concurrency: 1`. And a run
// re-entered after `step.sleep` is not a new start: it spends no rate.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { installJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';
import { limiter, resetLimiters } from './limiter';
import { limiterGate } from './limiter-gate';
import { manualSchedule } from './manual-schedule-fixture';
import { jobWorker } from './worker';

const VISIBILITY_MS = 5_000;
const HEARTBEAT_MS = 1_000;

const setup = () => {
  const clock = frozenClock('2026-11-14T00:00:00Z');
  const driver = memoryJobDriver({ clock });
  const timers = manualSchedule();
  const uninstall = installJobDriver(driver);
  const worker = jobWorker({
    driver,
    clock,
    schedule: timers.schedule,
    visibilityTimeoutMs: VISIBILITY_MS,
    heartbeatIntervalMs: HEARTBEAT_MS,
    pollIntervalMs: 0,
    context: () => ctxOf({ role: 'worker', buildId: 'test', clock }),
    drainOnShutdown: false,
  });
  return { clock, driver, timers, worker, uninstall };
};

const turns = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((done) => setImmediate(done));
};

afterEach(() => {
  resetLimiters();
  resetJobs();
});

describe('a limiter slot under the worker', () => {
  test('renews on WorkerOptions.schedule with the visibility timeout: no second holder', async () => {
    const { clock, driver, timers, worker, uninstall } = setup();
    const vendor = limiter('vendor', { concurrency: 1 });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = job({
      name: 'limited-hold',
      tenant: 'none',
      input: t.object({}),
      idempotencyKey: () => 'hold',
      retry: { attempts: 1 },
      limiter: vendor,
      run: () => held,
    });
    try {
      await send.enqueue({});
      const pass = worker.tick();
      await turns();
      // The lease heartbeat and the limiter slot, both on the worker's schedule.
      expect(timers.ticks(HEARTBEAT_MS)).toHaveLength(2);
      // Past the default 30 s TTL, renewed every beat: the slot is still this run's.
      for (let step = 0; step < 8; step += 1) {
        clock.advance(4_000);
        await timers.fire(HEARTBEAT_MS);
      }
      const otherProcess = limiterGate(limiter('vendor', { concurrency: 1 }), {
        leases: () => ({ store: driver.leases, driver: driver.name }),
        clock,
      });
      let refusal: string | undefined;
      try {
        await otherProcess.run('elsewhere', 'run-x', async () => undefined);
      } catch (error) {
        refusal = isUltimateError(error) ? error.code : 'not-coded';
      }
      expect(refusal).toBe('X_RATE_LIMITED');
      release();
      await pass;
    } finally {
      release();
      await worker.stop('test-end');
      uninstall();
    }
  });
  test('holds for the visibility timeout, not a fixed 30 s: a renewal-less slot lapses with the job', async () => {
    const { clock, driver, worker, uninstall } = setup();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stall = job({
      name: 'limited-stall',
      tenant: 'none',
      input: t.object({}),
      idempotencyKey: () => 'stall',
      retry: { attempts: 1 },
      limiter: limiter('vendor', { concurrency: 1 }),
      run: () => held,
    });
    try {
      await stall.enqueue({});
      const pass = worker.tick();
      await turns();
      // No beat fires — a SIGKILLed holder: past the 5 s visibility timeout the slot is free.
      clock.advance(VISIBILITY_MS + 1_000);
      const otherProcess = limiterGate(limiter('vendor', { concurrency: 1 }), {
        leases: () => ({ store: driver.leases, driver: driver.name }),
        clock,
      });
      expect(await otherProcess.run('elsewhere', 'run-y', async () => 'ran')).toBe('ran');
      release();
      await pass;
    } finally {
      release();
      await worker.stop('test-end');
      uninstall();
    }
  });
});

describe('a run re-entered after step.sleep', () => {
  const sleeper = (ran: { count: number }) =>
    job({
      name: 'limited-sleeper',
      tenant: 'none',
      input: t.object({ n: t.number }),
      idempotencyKey: ({ n }) => `sleeper:${n}`,
      retry: { attempts: 1 },
      limiter: limiter('vendor', { rate: { limit: 1, windowMs: 3_600_000 } }),
      async run({ step }) {
        await step.run('call', () => 'called');
        await step.sleep('1m');
        ran.count += 1;
      },
    });

  test('under the worker: the resume spends no rate, a new run still does', async () => {
    const { clock, worker, uninstall } = setup();
    const ran = { count: 0 };
    const handle = sleeper(ran);
    try {
      await handle.enqueue({ n: 1 });
      expect((await worker.tick()).map((one) => one.outcome)).toEqual(['suspended']);
      clock.advance(61_000);
      expect((await worker.tick()).map((one) => one.outcome)).toEqual(['completed']);
      expect(ran.count).toBe(1);
      await handle.enqueue({ n: 2 });
      expect((await worker.tick()).map((one) => one.outcome)).toEqual(['retried']);
    } finally {
      await worker.stop('test-end');
      uninstall();
    }
  });

  test('outside a worker (executeJob alone) the step store says it is a resume', async () => {
    const clock = frozenClock('2026-11-14T00:00:00Z');
    const driver = memoryJobDriver({ clock });
    const uninstall = installJobDriver(driver);
    const ran = { count: 0 };
    const handle = sleeper(ran);
    const ctx = ctxOf({ role: 'worker', buildId: 'test', clock });
    const once = async (): Promise<string> => {
      const [claimed] = await driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'w',
      });
      if (claimed === undefined) return 'nothing claimed';
      // The claim's own step list withheld: only the store can answer.
      const { steps: _steps, ...bare } = claimed;
      return (
        await executeJob({ driver, claimed: bare, handle: handle as AnyJobHandle, ctx, clock })
      ).outcome;
    };
    try {
      await handle.enqueue({ n: 1 });
      expect(await once()).toBe('suspended');
      clock.advance(61_000);
      expect(await once()).toBe('completed');
      expect(ran.count).toBe(1);
    } finally {
      uninstall();
    }
  });
});

describe('a run retried after its first step failed', () => {
  test('has done no work: the retry spends the rate like a fresh run', async () => {
    const { worker, uninstall } = setup();
    let calls = 0;
    const flaky = job({
      name: 'limited-flaky',
      tenant: 'none',
      input: t.object({}),
      idempotencyKey: () => 'flaky',
      retry: { attempts: 5, backoff: 'fixed', delay: 0, jitter: 'none' },
      limiter: limiter('vendor', { rate: { limit: 1, windowMs: 3_600_000 } }),
      async run({ step }) {
        // The subject's input, handed over rather than thrown: the vendor's failure.
        await step.run('call', () => {
          calls += 1;
          return Promise.reject(new TypeError('the vendor answered 500'));
        });
      },
    });
    try {
      await flaky.enqueue({});
      expect((await worker.tick()).map((one) => one.outcome)).toEqual(['retried']);
      // The failed step left a `failed` record; the retry is still a start and the window is spent.
      await worker.tick();
      await worker.tick();
      expect(calls).toBe(1);
    } finally {
      await worker.stop('test-end');
      uninstall();
    }
  });
});
