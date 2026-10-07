// A shed whose own nack fails. The round rethrows — the store is the thing failing, and the round
// is what reports it — but the claimed job the shed was FOR went nowhere: it sat `running` until its
// lease lapsed, an attempt spent on a body that never started, and on the final attempt the claim
// dead-lettered it. What is proven: it goes back with the jobs behind it, uncounted.

import { describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { concurrencyLimiter } from './limits';
import { createAdmission } from './worker-admit';
import type { FleetSlots, SlotGrant } from './worker-fleet-slots';

/** Not an `UltimateError`: it stands in for the store rejecting a statement. */
class StoreDown extends Error {}

/** Two jobs on a memory queue, both claimed, whose FIRST nack rejects and every later one lands. */
async function claimedPair() {
  const base = memoryJobDriver();
  let failNext = true;
  const driver: JobDriver = {
    ...base,
    nack(jobId, nack) {
      if (failNext) {
        failNext = false;
        return Promise.reject(new StoreDown('57P01'));
      }
      return base.nack(jobId, nack);
    },
  };
  for (const n of [1, 2]) {
    await base.enqueue({
      name: 'shed',
      queue: 'default',
      input: { n },
      idempotencyKey: `shed:${n}`,
      maxAttempts: 3,
    });
  }
  const claimed = await base.claim({
    queues: ['default'],
    limit: 2,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  expect(claimed).toHaveLength(2);
  const rows = async () =>
    Promise.all(claimed.map((job) => base.introspect?.job(job.id) ?? Promise.resolve(undefined)));
  return { driver, claimed, rows };
}

const slots = (grant: SlotGrant): FleetSlots => ({
  acquire: () => Promise.resolve(grant),
  startRenewal: () => () => undefined,
  release: () => Promise.resolve(),
});

async function admitRejects(
  admit: ReturnType<typeof createAdmission>,
  [job, ...behind]: readonly ClaimedJob[],
): Promise<void> {
  if (job === undefined) return expect.unreachable('nothing was claimed');
  let thrown: unknown;
  try {
    await admit(job, 'default', behind);
  } catch (error) {
    thrown = error;
  }
  // The store's failure still reaches the round: handing back is not swallowing.
  expect(thrown).toBeInstanceOf(StoreDown);
}

describe('a shed whose nack fails hands the job back with the rest', () => {
  test('over the in-process cap', async () => {
    const { driver, claimed, rows } = await claimedPair();
    const limiter = concurrencyLimiter({ ratePerTenant: { limit: 1, windowMs: 60_000 } });
    // The tenant's whole window, spent, so the admission below is shed over the cap.
    limiter.tryAcquire({ queue: 'default' });
    const admit = createAdmission({
      driver,
      limiter,
      fleetSlots: slots({ outcome: 'granted' }),
      workerId: 'w1',
      pollIntervalMs: 25,
      context: () => ctxOf(),
    });

    await admitRejects(admit, claimed);

    for (const row of await rows()) {
      expect(row?.state).toBe('ready');
      expect(row?.attempt).toBe(0);
    }
  });

  test('over the fleet cap', async () => {
    const { driver, claimed, rows } = await claimedPair();
    const admit = createAdmission({
      driver,
      limiter: concurrencyLimiter({}),
      fleetSlots: slots({ outcome: 'wait', limit: 1, key: undefined }),
      workerId: 'w1',
      pollIntervalMs: 25,
      context: () => ctxOf(),
    });

    await admitRejects(admit, claimed);

    for (const row of await rows()) {
      expect(row?.state).toBe('ready');
      expect(row?.attempt).toBe(0);
    }
  });
});
