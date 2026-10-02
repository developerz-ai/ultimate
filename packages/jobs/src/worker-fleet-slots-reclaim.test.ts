// One worker holding the SAME job twice: its first claim lapsed while the body kept running, and
// its own next pass claimed the row again. Both runs take a fleet slot under one job id — the
// second entry overwrote the first, the first run's settle released the SECOND run's slot, and the
// first's was never released: held to its TTL while the live run's renewal answered "lost".

import { afterEach, describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob } from './driver';
import { job, resetJobs } from './job';
import type { HeldLease } from './leases';
import { createMemoryLeaseStore, jobLeaseKey } from './leases';
import { createFleetSlots } from './worker-fleet-slots';

const passthrough: StandardSchemaV1<unknown, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
  },
};

afterEach(() => {
  resetJobs();
});

const claimed = (claim: number): ClaimedJob =>
  ({
    id: 'job-1',
    name: 'capped',
    queue: 'default',
    input: {},
    attempt: claim,
    claim,
  }) as ClaimedJob;

function fixture() {
  job({
    tenant: 'none',
    name: 'capped',
    input: passthrough,
    idempotencyKey: () => 'capped',
    retry: { attempts: 3 },
    concurrency: 2,
    run: () => Promise.resolve(),
  });
  const leases = createMemoryLeaseStore();
  /** Renewals armed by hand: each `tick` is one interval passing. */
  const ticks: (() => void)[] = [];
  const slots = createFleetSlots({
    leases,
    workerId: 'w1',
    ttlMs: 60_000,
    renewIntervalMs: 1_000,
    schedule: (tick) => {
      ticks.push(tick);
      return () => undefined;
    },
  });
  return { leases, slots, ticks, key: jobLeaseKey('capped', undefined) };
}

describe('the same job held twice by one worker', () => {
  test('both slots are handed back: nothing is left to expire on its TTL', async () => {
    const { leases, slots, key } = fixture();
    expect((await slots.acquire(claimed(1))).outcome).toBe('granted');
    expect((await slots.acquire(claimed(2))).outcome).toBe('granted');
    expect(await leases.held(key)).toBe(2);

    await slots.release('job-1');
    expect(await leases.held(key)).toBe(1);
    await slots.release('job-1');
    expect(await leases.held(key)).toBe(0);
  });

  test('the superseded run settling first frees ITS slot, and the live run keeps renewing its own', async () => {
    const { leases, slots, ticks, key } = fixture();
    await slots.acquire(claimed(1));
    slots.startRenewal('job-1');
    await slots.acquire(claimed(2));
    const lost: HeldLease[] = [];
    slots.startRenewal('job-1', (slot) => lost.push(slot));

    // The first body finally returns; its settle is fenced out, and its `finally` releases.
    await slots.release('job-1');
    expect(await leases.held(key)).toBe(1);
    // The live run's next renewal: its slot is still its own.
    ticks[1]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lost).toEqual([]);
  });
});
