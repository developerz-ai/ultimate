// What a run holds and what gives it back. The heartbeat is the one acquisition that starts before
// anything else, so every line between it and the `try` is a line that can leak an interval which
// renews the lease of a job that never ran — with no reference left to stop it, for the life of the
// process. `context()` was moved above the heartbeat for exactly that reason; this is the rest.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, ctxOf, frozenClock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import type { HeldLease } from './leases';
import type { IntervalScheduler } from './renewal-timer';
import type { FleetSlots } from './worker-fleet-slots';
import { runClaimedJob } from './worker-run';

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
      retry: { attempts: 1, jitter: 'none' },
      run: () => Promise.resolve(),
    });
    const schedule = armedTicks();

    await expect(
      runClaimedJob({
        driver: memoryJobDriver(),
        claimed: claimedOf('job-1'),
        context,
        fleetSlots: slotsThatThrowOnRenewal(),
        workerId: 'worker-1',
        visibilityTimeoutMs: 30_000,
        heartbeatIntervalMs: 5,
        pollIntervalMs: 25,
        schedule,
      }),
    ).rejects.toBeInstanceOf(SlotStoreDown);

    // Asked of the seam, not of a wall-clock window: nothing the run armed is still armed.
    expect(schedule.armed()).toBe(0);
  });
});

/** Not an `UltimateError`: it stands in for the app's own `WorkerOptions.context` failing. */
class ContextDown extends Error {}

/** One `wiredJob` on a memory queue, CLAIMED — `running`, its attempt spent by the claim. */
async function claimedOnMemory() {
  job({
    tenant: 'none',
    name: 'wiredJob',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'wired:1',
    retry: { attempts: 3, jitter: 'none' },
    run: () => Promise.resolve(),
  });
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: 'wiredJob',
    queue: 'default',
    input: {},
    idempotencyKey: 'wired:1',
    maxAttempts: 3,
  });
  const [claimed] = await driver.claim({
    queues: ['default'],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'worker-1',
  });
  if (claimed === undefined) return expect.unreachable('the memory queue claimed nothing');
  const before = await driver.introspect?.job(claimed.id);
  return { driver, claimed, before };
}

describe('a run that never started is handed back, not stranded', () => {
  for (const [where, wiring] of [
    [
      'the app context()',
      {
        context: (): Ctx => {
          throw new ContextDown('tenant lookup failed');
        },
      },
    ],
    ['the slot renewal', { context, fleetSlots: slotsThatThrowOnRenewal() }],
  ] as const) {
    test(`a throw from ${where} leaves the row ready, its attempt unspent`, async () => {
      const { driver, claimed, before } = await claimedOnMemory();
      expect(before?.state).toBe('running');

      let thrown: unknown;
      try {
        await runClaimedJob({
          driver,
          claimed,
          fleetSlots: {
            acquire: () => Promise.resolve({ outcome: 'granted' }),
            startRenewal: () => () => undefined,
            release: () => Promise.resolve(),
          },
          workerId: 'worker-1',
          visibilityTimeoutMs: 30_000,
          heartbeatIntervalMs: 5,
          pollIntervalMs: 25,
          schedule: armedTicks(),
          ...wiring,
        });
      } catch (error) {
        thrown = error;
      }

      // The wiring's own failure still reaches the round — handing back is not swallowing.
      expect(thrown).toBeInstanceOf(Error);
      const after = await driver.introspect?.job(claimed.id);
      // `ready` for the next worker, NOT `running` until the lease lapses: a final attempt spent
      // that way dead-letters a job whose body never ran.
      expect(after?.state).toBe('ready');
      expect(after?.attempt).toBe((before?.attempt ?? 0) - 1);
      expect(after?.lastError).toBeUndefined();
    });
  }
});

describe('a run admitted after its claim window', () => {
  test("a job admitted after its claim's window has lapsed is not run on the strength of a fresh local window", async () => {
    let ran = 0;
    job({
      tenant: 'none',
      name: 'lateJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'late:1',
      retry: { attempts: 3, jitter: 'none' },
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
    });
    const clock = frozenClock('2026-11-19T00:00:00.000Z');
    const driver = memoryJobDriver({ clock });
    await driver.enqueue({
      name: 'lateJob',
      queue: 'default',
      input: {},
      idempotencyKey: 'late:1',
      maxAttempts: 3,
    });
    const claimedAt = clock.now().getTime();
    const [claimed] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-1',
    });
    if (claimed === undefined) return expect.unreachable('the memory queue claimed nothing');
    // Admission (each job behind it a fleet-slot write on a slow database) outlasted the window.
    clock.advance(30_000);

    const thrown = await runClaimedJob({
      driver,
      claimed,
      claimedAt,
      context,
      fleetSlots: {
        acquire: () => Promise.resolve({ outcome: 'granted' }),
        startRenewal: () => () => undefined,
        release: () => Promise.resolve(),
      },
      workerId: 'worker-1',
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
      pollIntervalMs: 25,
      clock,
      schedule: armedTicks(),
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // Another worker may hold the row by now: the body never starts, and the row goes back
    // uncounted if — as here — nobody has taken it yet.
    expect(ran).toBe(0);
    expect(thrown).toMatchObject({ code: 'X_JOB_LEASE_LOST' });
    expect((await driver.introspect?.job(claimed.id))?.state).toBe('ready');
  });
});
