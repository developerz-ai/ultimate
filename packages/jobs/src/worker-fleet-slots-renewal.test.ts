// A fleet slot's renewal that keeps FAILING. One rejection is not a lost slot — there is a TTL
// behind it — but it was swallowed with no line, and a whole TTL of them was never noticed: the
// row lapsed, another worker took the slot, and two runs shared a `job.concurrency` of one in
// silence. One behaviour with the job's own lease (`heartbeat.ts`): warn each, lose it at the TTL.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob } from './driver';
import { job, resetJobs } from './job';
import type { HeldLease, LeaseStore } from './leases';
import { createMemoryLeaseStore } from './leases';
import { createFleetSlots } from './worker-fleet-slots';

const TTL_MS = 30_000;
const T0 = 1_790_000_000_000;

const passthrough: StandardSchemaV1<unknown, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
  },
};

function fakeClock(): Clock & { advance(ms: number): void } {
  let current = T0;
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

afterEach(() => {
  resetJobs();
});

const claimed = {
  id: 'job-1',
  name: 'capped',
  queue: 'default',
  input: {},
  attempt: 1,
} as ClaimedJob;

/** Lets the renewal's promise chain run to its end: macrotask order, not elapsed time. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function fixture(renew: LeaseStore['renew']) {
  job({
    tenant: 'none',
    name: 'capped',
    input: passthrough,
    idempotencyKey: () => 'capped',
    retry: { attempts: 3 },
    concurrency: 1,
    run: () => Promise.resolve(),
  });
  const clock = fakeClock();
  const ticks: (() => void)[] = [];
  const slots = createFleetSlots({
    leases: { ...createMemoryLeaseStore({ clock }), renew },
    workerId: 'w1',
    ttlMs: TTL_MS,
    renewIntervalMs: TTL_MS / 3,
    clock,
    schedule: (tick) => {
      ticks.push(tick);
      return () => undefined;
    },
  });
  await slots.acquire(claimed);
  const lost: HeldLease[] = [];
  const stop = slots.startRenewal('job-1', (slot) => lost.push(slot));
  const tick = async (): Promise<void> => {
    ticks[0]?.();
    await settled();
  };
  return { clock, tick, lost, stop };
}

describe('a slot renewal that fails', () => {
  test('one rejection is a warning, not a lost slot', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { clock, tick, lost } = await fixture(() => Promise.reject(new Error('57P01')));
      clock.advance(TTL_MS / 3);
      await tick();
      expect(lost).toEqual([]);
      const lines = warn.mock.calls.filter(([key]) => key === 'jobs.worker.slot-renewal-failed');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toMatchObject({ workerId: 'w1', jobId: 'job-1' });
    } finally {
      warn.mockRestore();
    }
  });

  test('a whole TTL of rejections loses the slot ONCE, and renewal stops', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const { clock, tick, lost } = await fixture(() => Promise.reject(new Error('57P01')));
      for (let pass = 0; pass < 5; pass += 1) {
        clock.advance(TTL_MS / 3);
        await tick();
      }
      expect(lost).toHaveLength(1);
      const lines = error.mock.calls.filter(([key]) => key === 'jobs.worker.slot-lost');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toMatchObject({ reason: 'expired' });
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test('a renewal that never ANSWERS is lost at the TTL too — nothing rejects to say so', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      let asked = 0;
      const { clock, tick, lost } = await fixture(() => {
        asked += 1;
        return new Promise<boolean>(() => undefined);
      });
      clock.advance(TTL_MS / 3);
      await tick();
      clock.advance(TTL_MS / 3);
      await tick();
      // One in flight at a time: the hung call is not stacked on.
      expect(asked).toBe(1);
      expect(lost).toEqual([]);
      clock.advance(TTL_MS / 3);
      await tick();
      expect(lost).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test('a slow renewal restarts the window from when it was SENT, as the store does', async () => {
    // The store stamps the slot's new expiry at the statement. Sent at 10 s and answered at 29 s,
    // the renewal bought a slot ending at 40 s — counted from the reply, this worker would hold
    // on to 59 s, sharing a `concurrency: 1` with whoever took the slot at 40.
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      let asked = 0;
      let advance = (_ms: number): void => undefined;
      const { clock, tick, lost } = await fixture(() => {
        asked += 1;
        if (asked === 1) advance(19_000);
        return Promise.resolve(true);
      });
      advance = (ms) => clock.advance(ms);
      clock.advance(TTL_MS / 3);
      await tick();
      expect(lost).toEqual([]);
      // To the store's expiry (10 s + 30 s), plus one interval.
      clock.advance(TTL_MS / 3 + TTL_MS - 19_000);
      await tick();
      expect(lost).toHaveLength(1);
      expect(asked).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  test('a renewal that lands restarts the window; a stopped renewal reports nothing', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const { clock, tick, lost, stop } = await fixture(() => Promise.resolve(true));
      for (let pass = 0; pass < 6; pass += 1) {
        clock.advance(TTL_MS / 3);
        await tick();
      }
      expect(lost).toEqual([]);
      stop();
      clock.advance(TTL_MS * 2);
      await tick();
      expect(lost).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});
