// The gate a named limiter is spent through, over the memory lease store on a frozen clock: what a
// refusal says, what is handed back when a run never starts, what stays counted, and the wiring —
// `job({ limiter })` deferred by `executeJob` with the attempt uncounted.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, frozenClock, isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { ClaimedJob, NackOptions } from './driver';
import { installJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';
import { memoryLeaseStore } from './leases';
import type { JobLimiter } from './limiter';
import { limiter, resetLimiters } from './limiter';
import { LIMITER_CONCURRENCY_RETRY_SECONDS, limiterGate, limiterLeaseKey } from './limiter-gate';

const clock = frozenClock('2026-11-14T00:00:00Z');

const gateOver = (declared: JobLimiter, store = memoryLeaseStore({ clock })) => ({
  store,
  gate: limiterGate(declared, { leases: () => ({ store, driver: 'memory' }), clock }),
});

/** The refusal a gate threw, as `executeJob` reads it. */
const refusalOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, meta: error.meta };
    throw error;
  }
  return undefined;
};

/** A body held open until `release()`, so a test decides when a run ends. */
const held = () => {
  let release = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { body: () => done, release: () => release() };
};

afterEach(() => {
  resetLimiters();
  resetJobs();
});

describe('limiterGate', () => {
  test('past the concurrency a run is refused X_RATE_LIMITED, and its slot frees when one ends', async () => {
    const { gate, store } = gateOver(limiter('vendor', { concurrency: 1 }));
    const first = held();
    const running = gate.run('send', 'run-1', first.body);
    // Another PROCESS — its own fast path, the same store — is refused by the store's row.
    const other = limiterGate(limiter('vendor', { concurrency: 1 }), {
      leases: () => ({ store, driver: 'memory' }),
      clock,
    });
    expect(await refusalOf(other.run('send', 'run-2', async () => 'ran'))).toEqual({
      code: 'X_RATE_LIMITED',
      meta: expect.objectContaining({
        refusal: 'concurrency',
        retryAfterSeconds: LIMITER_CONCURRENCY_RETRY_SECONDS,
      }),
    });
    first.release();
    await running;
    expect(await store.held(limiterLeaseKey('vendor', 'concurrency'))).toBe(0);
    expect(await other.run('send', 'run-2', async () => 'ran')).toBe('ran');
  });

  test('the fast path refuses in-process without asking the store', async () => {
    const { gate, store } = gateOver(limiter('vendor', { concurrency: 1 }));
    let asked = 0;
    const counting = limiterGate(limiter('vendor', { concurrency: 1 }), {
      leases: () => ({
        store: {
          ...store,
          acquire: (...args) => {
            asked += 1;
            return store.acquire(...args);
          },
        },
        driver: 'memory',
      }),
      clock,
    });
    const first = held();
    const running = counting.run('send', 'run-1', first.body);
    await Bun.sleep(0);
    expect((await refusalOf(counting.run('send', 'run-2', async () => 1)))?.code).toBe(
      'X_RATE_LIMITED',
    );
    expect(asked).toBe(1);
    first.release();
    await running;
    expect(await gate.run('send', 'run-3', async () => 3)).toBe(3);
  });

  test('a start stays counted for its window and the refusal names when the window opens', async () => {
    const { gate } = gateOver(limiter('vendor', { rate: { limit: 2, windowMs: 10_000 } }));
    await gate.run('send', 'run-1', async () => undefined);
    clock.advance(4_000);
    await gate.run('send', 'run-2', async () => undefined);
    const refusal = await refusalOf(gate.run('send', 'run-3', async () => undefined));
    // The first stamp lapses 6 s from now: that is the wait, not the whole window.
    expect(refusal).toEqual({
      code: 'X_RATE_LIMITED',
      meta: expect.objectContaining({ refusal: 'rate', retryAfterSeconds: 6 }),
    });
    clock.advance(6_000);
    expect(await gate.run('send', 'run-3', async () => 'ran')).toBe('ran');
  });

  test('refused on rate, the concurrency slot it took goes back; a throwing body frees its slot', async () => {
    const { gate, store } = gateOver(
      limiter('vendor', { rate: { limit: 1, windowMs: 10_000 }, concurrency: 1 }),
    );
    await gate.run('send', 'run-1', async () => undefined);
    expect((await refusalOf(gate.run('send', 'run-2', async () => undefined)))?.code).toBe(
      'X_RATE_LIMITED',
    );
    expect(await store.held(limiterLeaseKey('vendor', 'concurrency'))).toBe(0);
    clock.advance(10_000);
    const thrown = await refusalOf(
      gate.run('send', 'run-3', () => Promise.reject(new TypeError('the body failed'))),
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(TypeError);
    expect(await store.held(limiterLeaseKey('vendor', 'concurrency'))).toBe(0);
  });

  test('a driver with no lease store is X_JOB_CONCURRENCY_UNENFORCEABLE, never per-process', async () => {
    const gate = limiterGate(limiter('vendor', { concurrency: 1 }), {
      leases: () => ({ store: undefined, driver: 'redis' }),
    });
    expect((await refusalOf(gate.run('send', 'run-1', async () => 1)))?.code).toBe(
      'X_JOB_CONCURRENCY_UNENFORCEABLE',
    );
  });
});

describe('job({ limiter })', () => {
  test('a refused run is deferred with its attempt uncounted, even on its last attempt', async () => {
    const vendor = limiter('vendor', { rate: { limit: 1, windowMs: 60_000 } });
    const base = memoryJobDriver({ clock });
    const nacks: NackOptions[] = [];
    const driver = {
      ...base,
      async nack(jobId: string, nack: NackOptions) {
        nacks.push(nack);
        return base.nack(jobId, nack);
      },
    };
    const uninstall = installJobDriver(driver);
    let ran = 0;
    const send = job({
      name: 'limited-send',
      tenant: 'none',
      input: t.object({ n: t.number }),
      idempotencyKey: ({ n }) => `limited-send:${n}`,
      retry: { attempts: 1, jitter: 'none' },
      limiter: vendor,
      run: async () => {
        ran += 1;
      },
    });
    try {
      const ctx: Ctx = ctxOf({ role: 'worker', buildId: 'test' });
      const outcomes: string[] = [];
      for (const n of [1, 2]) {
        await driver.enqueue({
          name: send.name,
          queue: 'default',
          input: { n },
          idempotencyKey: `limited-send:${n}`,
          maxAttempts: 1,
        });
        const [claimed] = await driver.claim({
          queues: ['default'],
          limit: 1,
          visibilityTimeoutMs: 30_000,
          workerId: 'w',
        });
        const execution = await executeJob({
          driver,
          claimed: claimed as ClaimedJob,
          handle: send as AnyJobHandle,
          ctx,
        });
        outcomes.push(execution.outcome);
      }
      expect(ran).toBe(1);
      expect(outcomes).toEqual(['completed', 'retried']);
      expect(nacks).toEqual([expect.objectContaining({ countsAsAttempt: false })]);
      expect(nacks[0]?.delayMs).toBeGreaterThanOrEqual(60_000);
    } finally {
      uninstall();
    }
  });
});
