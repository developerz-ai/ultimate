// `args.lease`: the body's own handle on the lease the worker renews for it. A synchronous section
// longer than the visibility window starves the renewal timer; `renew()` between its chunks is
// what keeps a second worker from claiming the row underneath it.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { startLeaseHeartbeat } from './heartbeat';
import { job, resetJobs } from './job';
import type { JobLease } from './job-lease';
import { jobLease } from './job-lease';
import type { IntervalScheduler } from './renewal-timer';
import { runClaimedJob } from './worker-run';

const VISIBILITY_MS = 1_000;

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

/** A renewal timer that never fires: the body's synchronous section has starved it. */
const starved: IntervalScheduler = () => () => undefined;

const fleetSlots = {
  acquire: () => Promise.resolve({ outcome: 'granted' as const }),
  startRenewal: () => () => undefined,
  release: () => Promise.resolve(),
};

const claimedRow = (): ClaimedJob => ({
  id: 'job-1',
  name: 'leased',
  queue: 'default',
  input: null,
  idempotencyKey: 'leased:1',
  runId: 'run-1',
  attempt: 1,
  maxAttempts: 1,
  state: 'running',
  runAt: 0,
  createdAt: 0,
  updatedAt: 0,
  claimedAt: 0,
  visibleAt: VISIBILITY_MS,
  claimedBy: 'worker-1',
  claim: 1,
});

afterEach(() => {
  resetJobs();
});

describe('args.lease', () => {
  test('renew() through a 2x-visibility synchronous loop keeps the row unclaimable', async () => {
    const clock = frozenClock('2026-11-12T00:00:00Z');
    const driver = memoryJobDriver({ clock });
    const answers: boolean[] = [];
    const stolen: number[] = [];
    job({
      tenant: 'none',
      name: 'leased',
      input: passthrough<null>(),
      idempotencyKey: () => 'leased:1',
      retry: { attempts: 1, jitter: 'none' },
      async run({ lease }) {
        for (let chunk = 0; chunk < 5; chunk += 1) {
          clock.advance(VISIBILITY_MS * 0.4);
          answers.push((await lease?.renew()) ?? false);
          const other = await driver.claim({
            queues: ['default'],
            limit: 1,
            visibilityTimeoutMs: VISIBILITY_MS,
            workerId: 'worker-2',
          });
          stolen.push(other.length);
        }
      },
    });
    await driver.enqueue({
      name: 'leased',
      queue: 'default',
      input: null,
      idempotencyKey: 'leased:1',
      maxAttempts: 1,
    });
    const [claimed] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: VISIBILITY_MS,
      workerId: 'worker-1',
    });
    if (claimed === undefined) return expect.unreachable('the memory queue claimed nothing');

    const execution = await runClaimedJob({
      driver,
      claimed,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      fleetSlots,
      workerId: 'worker-1',
      visibilityTimeoutMs: VISIBILITY_MS,
      heartbeatIntervalMs: VISIBILITY_MS / 3,
      pollIntervalMs: 25,
      clock,
      schedule: starved,
    });

    expect(answers).toEqual([true, true, true, true, true]);
    expect(stolen).toEqual([0, 0, 0, 0, 0]);
    expect(execution.outcome).toBe('completed');
  });

  test('a refused renewal answers false, and lost() and the signal agree', async () => {
    const heartbeat = startLeaseHeartbeat({
      driver: { heartbeat: () => Promise.resolve(false) },
      claimed: claimedRow(),
      visibilityTimeoutMs: VISIBILITY_MS,
      intervalMs: 100,
      workerId: 'worker-1',
      clock: frozenClock(0),
      schedule: starved,
    });
    const lease: JobLease = jobLease(heartbeat);
    expect(lease.lost()).toBe(false);
    expect(await lease.renew()).toBe(false);
    expect(lease.lost()).toBe(true);
    expect(lease.signal.aborted).toBe(true);
  });

  test('renew() during a HUNG timer renewal neither hangs the body nor sends a second', async () => {
    let sent = 0;
    const heartbeat = startLeaseHeartbeat({
      driver: {
        heartbeat: () => {
          sent += 1;
          return new Promise<boolean>(() => undefined);
        },
      },
      claimed: claimedRow(),
      visibilityTimeoutMs: VISIBILITY_MS,
      intervalMs: 100,
      workerId: 'worker-1',
      clock: frozenClock(0),
      schedule: starved,
    });
    void heartbeat.renew();
    // Inside the window with a renewal on the wire, the lease is held as far as anyone can know.
    expect(await jobLease(heartbeat).renew()).toBe(true);
    expect(sent).toBe(1);
  });

  test('after the settle stops the heartbeat, renew() answers false and the signal aborts', async () => {
    let sent = 0;
    const heartbeat = startLeaseHeartbeat({
      driver: {
        heartbeat: () => {
          sent += 1;
          return Promise.resolve(true);
        },
      },
      claimed: claimedRow(),
      visibilityTimeoutMs: VISIBILITY_MS,
      intervalMs: 100,
      workerId: 'worker-1',
      clock: frozenClock(0),
      schedule: starved,
    });
    const lease = jobLease(heartbeat);
    expect(await lease.renew()).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    // `settlingStops`: the ack is on the wire, the row is no longer this attempt's.
    heartbeat.stop();
    expect(await lease.renew()).toBe(false);
    expect(lease.signal.aborted).toBe(true);
    expect(sent).toBe(1);
    // The body's view only: a stop is not a loss, so nothing reports one.
    expect(lease.lost()).toBe(false);
    expect(heartbeat.signal.aborted).toBe(false);
  });
});
