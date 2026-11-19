// A lease's window starts when the row was CLAIMED, not when its run started. A batch is admitted
// one job at a time, each admission a write, so a job may start well after the claim that bought
// its lease: measured from the start, the heartbeat believed in time the server had already spent.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, resetMetrics } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { startLeaseHeartbeat } from './heartbeat';

const VISIBILITY_MS = 30_000;
const INTERVAL_MS = 10_000;

const claimed: ClaimedJob = {
  id: 'job-1',
  name: 'sendInvite',
  queue: 'emails',
  input: {},
  idempotencyKey: 'invite:1',
  runId: 'run-1',
  attempt: 1,
  maxAttempts: 3,
  state: 'running',
  runAt: 0,
  createdAt: 0,
  updatedAt: 0,
  claimedAt: 0,
  visibleAt: VISIBILITY_MS,
  claimedBy: 'worker-1',
  claim: 1,
};

/** A heartbeat started `startedAfterMs` after the claim was asked, on a timer that never fires. */
function startedLate(startedAfterMs: number, claimedAt?: number) {
  const clock = frozenClock(0);
  let renewals = 0;
  clock.advance(startedAfterMs);
  const heartbeat = startLeaseHeartbeat({
    driver: {
      heartbeat: () => {
        renewals += 1;
        return Promise.resolve(true);
      },
    },
    claimed,
    visibilityTimeoutMs: VISIBILITY_MS,
    intervalMs: INTERVAL_MS,
    workerId: 'worker-1',
    clock,
    schedule: () => () => undefined,
    ...(claimedAt === undefined ? {} : { claimedAt }),
  });
  return { heartbeat, renewals: () => renewals };
}

// A lost lease is counted (`job_leases_lost_total`): never left for the next file to read.
afterEach(() => {
  resetMetrics();
});

describe('a lease measured from its claim', () => {
  test('a run started past its whole window is lost before its body could start', () => {
    const { heartbeat, renewals } = startedLate(VISIBILITY_MS, 0);
    expect(heartbeat.lost()).toBe(true);
    expect(heartbeat.signal.aborted).toBe(true);
    // Nothing renewed: a renewal now would extend a lease the queue may have handed on.
    expect(renewals()).toBe(0);
    heartbeat.stop();
  });

  test('a run started past one interval renews at once, and keeps a healthy lease', async () => {
    const { heartbeat, renewals } = startedLate(VISIBILITY_MS - 5_000, 0);
    // Asked synchronously at the start, not an interval later: by then the window had lapsed.
    expect(renewals()).toBe(1);
    await heartbeat.renew();
    expect(heartbeat.lost()).toBe(false);
    heartbeat.stop();
  });

  test('a run started inside its first interval waits for the timer, as it always did', () => {
    const { heartbeat, renewals } = startedLate(INTERVAL_MS - 1, 0);
    expect(renewals()).toBe(0);
    expect(heartbeat.lost()).toBe(false);
    heartbeat.stop();
  });

  test('with no claim instant, the window starts at the run', () => {
    const { heartbeat, renewals } = startedLate(VISIBILITY_MS);
    expect(renewals()).toBe(0);
    expect(heartbeat.lost()).toBe(false);
    heartbeat.stop();
  });
});
