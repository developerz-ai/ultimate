// What a run holds and what gives it back. The heartbeat is the one acquisition that starts before
// anything else, so every line between it and the `try` is a line that can leak an interval which
// renews the lease of a job that never ran — with no reference left to stop it, for the life of the
// process. `context()` was moved above the heartbeat for exactly that reason; this is the rest.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import type { HeldLease } from './leases';
import type { IntervalScheduler } from './renewal-timer';
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
  acquire: () => Promise.resolve({ outcome: 'granted' }),
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
  claimedBy: 'worker-1',
  claim: 1,
});

/** The renewal seam, holding what is armed: a heartbeat nobody stopped is a tick left behind. */
function armedTicks(): IntervalScheduler & { readonly armed: () => number } {
  const ticks = new Set<() => void>();
  const schedule: IntervalScheduler = (tick) => {
    ticks.add(tick);
    return () => {
      ticks.delete(tick);
    };
  };
  return Object.assign(schedule, { armed: () => ticks.size });
}

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
    const schedule = armedTicks();

    await expect(
      runClaimedJob({
        driver: createMemoryDriver(),
        claimed: claimedOf('job-1'),
        context,
        fleetSlots: slotsThatThrowOnRenewal(),
        workerId: 'worker-1',
        visibilityTimeoutMs: 30_000,
        heartbeatIntervalMs: 5,
        schedule,
      }),
    ).rejects.toBeInstanceOf(SlotStoreDown);

    // Asked of the seam, not of a wall-clock window: nothing the run armed is still armed.
    expect(schedule.armed()).toBe(0);
  });
});
