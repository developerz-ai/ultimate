// What a run holds and what gives it back. The heartbeat is the one acquisition that starts before
// anything else, so every line between it and the `try` is a line that can leak an interval which
// renews the lease of a job that never ran — with no reference left to stop it, for the life of the
// process. `context()` was moved above the heartbeat for exactly that reason; this is the rest.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import type { HeldLease } from './leases';
import type { FleetSlots } from './worker-fleet-slots';
import { runClaimedJob } from './worker-run';

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

/** Not an `UltimateError`: it stands in for whatever an injected `FleetSlots` throws. */
class SlotStoreDown extends Error {}

const slotsThatThrowOnRenewal = (): FleetSlots => ({
  acquire: () => Promise.resolve(true),
  startRenewal: (_jobId: string, _onLost?: (slot: HeldLease) => void): (() => void) => {
    throw new SlotStoreDown('lease store unreachable');
  },
  release: () => Promise.resolve(),
});

const claimedOf = (id: string): ClaimedJob => ({
  id,
  name: 'wiredJob',
  queue: 'default',
  input: {},
  idempotencyKey: `wired:${id}`,
  runId: `run-${id}`,
  attempt: 1,
  maxAttempts: 1,
  state: 'running',
  runAt: 0,
  createdAt: 0,
  updatedAt: 0,
  claimedAt: 0,
  visibleAt: 30_000,
});

/** A driver that counts renewals, so a heartbeat nobody stopped is visible as ticks after the throw. */
function countingDriver(): JobDriver & { beats: () => number } {
  const driver = createMemoryDriver();
  let beats = 0;
  return {
    ...driver,
    beats: () => beats,
    heartbeat: (jobId, options) => {
      beats += 1;
      return driver.heartbeat(jobId, options);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  resetJobs();
});

describe('a run hands back everything it took', () => {
  test('a throw between the heartbeat and the body still stops the heartbeat', async () => {
    job({
      tenant: 'none',
      name: 'wiredJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'wired:1',
      retry: { attempts: 1, jitter: false },
      run: () => Promise.resolve(),
    });
    const driver = countingDriver();

    await expect(
      runClaimedJob({
        driver,
        claimed: claimedOf('job-1'),
        context,
        fleetSlots: slotsThatThrowOnRenewal(),
        workerId: 'worker-1',
        visibilityTimeoutMs: 30_000,
        // Short enough that a leaked interval ticks several times inside the window below, and
        // real time rather than the frozen clock — `startRenewalTimer` is `setInterval`.
        heartbeatIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(SlotStoreDown);

    const afterThrow = driver.beats();
    await sleep(60);
    expect(driver.beats()).toBe(afterThrow);
  });
});
