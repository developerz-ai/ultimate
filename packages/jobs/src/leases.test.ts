// J4/J5: `job.concurrency` was declared, documented, in the manifest, and enforced by nothing.
// The failure case first — a SECOND worker must be refused — because that is the guarantee an
// agent reads off the docstring and ships against.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createMemoryLeaseStore, jobLeaseKey } from './leases';
import { createWorker } from './worker';

afterEach(() => {
  resetJobs();
});

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe('fleet-wide job concurrency', () => {
  test('a SECOND worker is refused while the first holds the only slot', async () => {
    // Two workers, one shared lease store — the deployment shape: two pods, one Postgres. Before
    // `x_job_leases` both ran `rebuildSearchIndex` at once while `x jobs show` and the manifest
    // both reported `concurrency: 1`.
    const leases = createMemoryLeaseStore();
    const driverA = createMemoryDriver({ leases });
    const driverB = createMemoryDriver({ leases });

    const gate = deferred();
    let started = 0;
    const rebuildSearchIndex = job({
      tenant: 'none',
      name: 'rebuildSearchIndex',
      input: passthrough<{ shard: string }>(),
      idempotencyKey: (input) => `shard:${input.shard}`,
      retry: { attempts: 1 },
      concurrency: 1,
      async run() {
        started += 1;
        await gate.promise;
      },
    });

    // One job per driver: each worker has something claimable, so only the LEASE can refuse one.
    await driverA.enqueue({
      name: 'rebuildSearchIndex',
      queue: 'default',
      input: { shard: 'a' },
      idempotencyKey: 'shard:a',
      maxAttempts: 1,
    });
    await driverB.enqueue({
      name: 'rebuildSearchIndex',
      queue: 'default',
      input: { shard: 'b' },
      idempotencyKey: 'shard:b',
      maxAttempts: 1,
    });

    const workerA = createWorker({
      driver: driverA,
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });
    const workerB = createWorker({
      driver: driverB,
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });

    void workerA.tick();
    // Let the first round claim and start before the second worker reaches for the same slot.
    await Bun.sleep(5);
    await workerB.tick();

    expect(started).toBe(1);
    expect(await leases.held(jobLeaseKey('rebuildSearchIndex'))).toBe(1);

    // The refused job is parked, NOT failed: it must not burn an attempt for being over a cap.
    const parked = await driverB.introspect?.list({ name: 'rebuildSearchIndex' });
    expect(parked?.[0]?.state).toBe('suspended');
    expect(parked?.[0]?.attempt).toBe(0);

    gate.resolve();
    await workerA.stop('test');
    await workerB.stop('test');

    // The slot came back with the job, so the next round can fill it.
    expect(await leases.held(jobLeaseKey('rebuildSearchIndex'))).toBe(0);
    expect(rebuildSearchIndex.concurrency).toBe(1);
  });

  test('a job with NO concurrency never touches the lease table', async () => {
    const leases = createMemoryLeaseStore();
    const driver = createMemoryDriver({ leases });
    job({
      tenant: 'none',
      name: 'uncapped',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'one',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    await driver.enqueue({
      name: 'uncapped',
      queue: 'default',
      input: {},
      idempotencyKey: 'one',
      maxAttempts: 1,
    });
    const worker = createWorker({
      driver,
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });
    await worker.tick();
    expect(await leases.held(jobLeaseKey('uncapped'))).toBe(0);
    await worker.stop('test');
  });

  test('a driver with no lease store REFUSES to start when a job declares concurrency', () => {
    // The minimum bar: a documented guarantee that silently does nothing is the worst of the
    // three options, so a driver that cannot hold the cap does not get to claim it.
    job({
      tenant: 'none',
      name: 'cappedButUnenforceable',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'one',
      retry: { attempts: 1 },
      concurrency: 2,
      run: () => Promise.resolve(),
    });
    const { leases: _dropped, ...withoutLeases } = createMemoryDriver();
    const worker = createWorker({
      // The lease store is what makes it enforceable, so a driver without one is the case.
      driver: withoutLeases,
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });
    expect(() => {
      worker.start();
    }).toThrow(/cappedButUnenforceable/);
  });
});

describe('the lease store itself', () => {
  test('slots are handed out up to the limit and no further', async () => {
    const store = createMemoryLeaseStore();
    const first = await store.acquire('job:x', 2, 1000, 'a');
    const second = await store.acquire('job:x', 2, 1000, 'b');
    const third = await store.acquire('job:x', 2, 1000, 'c');
    expect(first?.slot).toBe(0);
    expect(second?.slot).toBe(1);
    expect(third).toBeUndefined();
  });

  test('an expired slot is reclaimed, so a SIGKILLed worker does not hold it forever', async () => {
    let at = 1_000_000;
    const store = createMemoryLeaseStore({
      clock: { now: () => new Date(at), monotonic: () => at },
    });
    const held = await store.acquire('job:x', 1, 5_000, 'dead-worker');
    expect(held).toBeDefined();
    expect(await store.acquire('job:x', 1, 5_000, 'live-worker')).toBeUndefined();

    at += 5_001;
    expect(await store.acquire('job:x', 1, 5_000, 'live-worker')).toBeDefined();
    // And the dead worker's renewal does NOT revive a slot somebody else now holds.
    expect(held === undefined ? false : await store.renew(held, 5_000)).toBe(false);
  });

  test('release by a non-holder is a no-op — two runs must never share one slot', async () => {
    const store = createMemoryLeaseStore();
    const held = await store.acquire('job:x', 1, 1000, 'a');
    expect(held).toBeDefined();
    if (held === undefined) return;
    await store.release({ ...held, holder: 'b' });
    expect(await store.held('job:x')).toBe(1);
    await store.release(held);
    expect(await store.held('job:x')).toBe(0);
  });
});
