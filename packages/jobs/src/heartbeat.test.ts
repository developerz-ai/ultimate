// A lease that lapses is one job running twice, and before this it lapsed in silence: the
// heartbeat's `.catch(() => undefined)` swallowed every failure, so the only trace of a
// double-delivered job was a second run nobody could explain. What is proven here is WHEN the
// loss is declared — one failed renewal is not a lost lease, an expired window is — and that a
// heartbeat which never answers at all is still caught.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { FrozenClock } from '@ultimat3/core';
import { collectMetrics, frozenClock, logger, resetMetrics } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { startLeaseHeartbeat } from './heartbeat';

const VISIBILITY_MS = 30_000;

const claimed: ClaimedJob = {
  id: 'job-1',
  name: 'sendInvite',
  queue: 'emails',
  input: {},
  idempotencyKey: 'invite:1',
  runId: 'run-1',
  attempt: 0,
  maxAttempts: 3,
  state: 'running',
  runAt: 0,
  createdAt: 0,
  updatedAt: 0,
  claimedAt: 0,
  visibleAt: VISIBILITY_MS,
};

const lostCount = (queue: string): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === 'job_leases_lost_total')
    ?.points.find((point) => point.attributes['queue'] === queue)?.value;

interface Harness {
  readonly clock: FrozenClock;
  /** How many times the driver was actually asked to renew. */
  renewals(): number;
  readonly heartbeat: ReturnType<typeof startLeaseHeartbeat>;
}

/**
 * A lease over a driver whose heartbeat answers however the test says, `clock` in hand so a call
 * can take time to fail. `intervalMs` is an hour on purpose: `renew()` is driven by hand here, so
 * nothing in these assertions depends on a real timer firing.
 */
function held(heartbeat: (clock: FrozenClock) => Promise<void>): Harness {
  const clock = frozenClock(0);
  let renewals = 0;
  return {
    clock,
    renewals: () => renewals,
    heartbeat: startLeaseHeartbeat({
      driver: {
        heartbeat: async () => {
          renewals += 1;
          await heartbeat(clock);
          return true;
        },
      },
      claimed,
      visibilityTimeoutMs: VISIBILITY_MS,
      intervalMs: 3_600_000,
      workerId: 'worker-1',
      clock,
    }),
  };
}

afterEach(() => {
  resetMetrics();
});

describe('a renewal that lands holds the lease', () => {
  test('a healthy heartbeat never reports a loss, however long the job runs', async () => {
    const harness = held(() => Promise.resolve());

    // Well past the visibility timeout in total, never past it since the last renewal.
    for (let elapsed = 0; elapsed < VISIBILITY_MS * 3; elapsed += 10_000) {
      harness.clock.advance(10_000);
      await harness.heartbeat.renew();
    }
    harness.heartbeat.stop();

    expect(harness.heartbeat.lost()).toBe(false);
    expect(lostCount('emails')).toBeUndefined();
  });

  test('one failed renewal is not a lost lease — the window has room for the next', async () => {
    const warn = spyOn(logger, 'warn');
    const harness = held(() => Promise.reject(new Error('connection reset')));

    harness.clock.advance(VISIBILITY_MS / 3);
    await harness.heartbeat.renew();
    const failed = warn.mock.calls.filter((call) => call[0] === 'jobs.heartbeat.failed');
    warn.mockRestore();
    harness.heartbeat.stop();

    // Said out loud, because a queue that cannot be reached is worth knowing about...
    // `renderThrowable`'s form, `Name: message` — a caught value is rendered totally, never
    // through `String(error)`, which raises on a null-prototype throwable inside a `catch`.
    expect(failed[0]?.[1]).toMatchObject({ jobId: 'job-1', error: 'Error: connection reset' });
    // ...but the lease is still this worker's: nobody else can claim the job yet.
    expect(harness.heartbeat.lost()).toBe(false);
    expect(lostCount('emails')).toBeUndefined();
  });
});

describe('a lease that lapses is named', () => {
  test('renewals that stop landing across the window report the loss exactly once', async () => {
    const error = spyOn(logger, 'error');
    const harness = held(() => Promise.reject(new Error('connection reset')));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      harness.clock.advance(VISIBILITY_MS / 2);
      await harness.heartbeat.renew();
    }
    const lost = error.mock.calls.filter((call) => call[0] === 'jobs.lease.lost');
    error.mockRestore();

    expect(harness.heartbeat.lost()).toBe(true);
    expect(lost.length).toBe(1);
    expect(lost[0]?.[1]).toMatchObject({
      workerId: 'worker-1',
      job: 'sendInvite',
      jobId: 'job-1',
      queue: 'emails',
      attempt: 0,
      visibilityTimeoutMs: VISIBILITY_MS,
    });
    // One point per JOB, not per interval: this series counts jobs that ran twice.
    expect(lostCount('emails')).toBe(1);
  });

  test('a renewal that fails only after the window is gone carries its error', async () => {
    const error = spyOn(logger, 'error');
    // The realistic shape: the call does not fail fast, it fails at the end of a connect timeout
    // — by which point the queue has already handed the job to somebody else.
    const harness = held((clock) => {
      clock.advance(VISIBILITY_MS + 1);
      return Promise.reject(new Error('connection reset'));
    });

    await harness.heartbeat.renew();
    const lost = error.mock.calls.filter((call) => call[0] === 'jobs.lease.lost');
    error.mockRestore();

    expect(lost[0]?.[1]).toMatchObject({ jobId: 'job-1', error: 'Error: connection reset' });
    expect(lostCount('emails')).toBe(1);
  });

  test('a heartbeat that never answers is still caught', async () => {
    // The quietest failure of all: a call hung on a dead connection neither resolves nor rejects,
    // so a check that ran only on rejection would never run.
    const harness = held(() => new Promise<void>(() => undefined));

    // Not awaited, because it never settles — which is the failure under test.
    void harness.heartbeat.renew();
    await harness.heartbeat.renew();
    // One renewal in flight at a time: a driver slower than the interval must not collect a
    // request per tick on the connection that is already the thing failing.
    expect(harness.renewals()).toBe(1);

    harness.clock.advance(VISIBILITY_MS + 1);
    await harness.heartbeat.renew();

    expect(harness.heartbeat.lost()).toBe(true);
    expect(lostCount('emails')).toBe(1);
    expect(harness.renewals()).toBe(1);
  });

  test('a renewal that SUCCEEDS after the window is gone is still a loss', async () => {
    const error = spyOn(logger, 'error');
    // The renewal lands — it just lands too late: an event-loop stall, or a driver that answered
    // at the end of its connect timeout. Trusting the resolution here would restart the window on
    // a lease the queue has already re-delivered, hiding the loss inside the call meant to prevent
    // it. This is the ONLY failure shape with nothing to catch.
    const harness = held((clock) => {
      clock.advance(VISIBILITY_MS + 1);
      return Promise.resolve();
    });

    await harness.heartbeat.renew();
    const lost = error.mock.calls.filter((call) => call[0] === 'jobs.lease.lost');
    error.mockRestore();

    expect(harness.heartbeat.lost()).toBe(true);
    expect(lost.length).toBe(1);
    expect(lostCount('emails')).toBe(1);
    // And the window is not restarted behind it: renewing past the loss extends somebody else's.
    await harness.heartbeat.renew();
    expect(harness.renewals()).toBe(1);
  });

  test('a renewal that lands after the loss does not revive the lease', async () => {
    let land = (): void => undefined;
    const harness = held(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );

    void harness.heartbeat.renew();
    harness.clock.advance(VISIBILITY_MS + 1);
    await harness.heartbeat.renew();
    // The hung call finally answers — long after the queue was free to re-deliver the job.
    land();
    await Bun.sleep(0);
    await harness.heartbeat.renew();

    expect(harness.heartbeat.lost()).toBe(true);
    // A late success is not a lease: this window is somebody else's now, whatever the driver said.
    expect(harness.renewals()).toBe(1);
    expect(lostCount('emails')).toBe(1);
  });

  test('a lost lease stops renewing — it belongs to another worker now', async () => {
    const harness = held(() => Promise.reject(new Error('connection reset')));

    harness.clock.advance(VISIBILITY_MS / 2);
    await harness.heartbeat.renew();
    const asked = harness.renewals();
    harness.clock.advance(VISIBILITY_MS);
    await harness.heartbeat.renew();
    await harness.heartbeat.renew();

    expect(harness.heartbeat.lost()).toBe(true);
    expect(asked).toBe(1);
    // Renewing past the loss would extend a lease this process no longer holds.
    expect(harness.renewals()).toBe(asked);
    expect(lostCount('emails')).toBe(1);
  });
});

describe('a clean completion is not a lost lease', () => {
  test('the renewal already on the wire when stop() lands reports nothing', async () => {
    const error = spyOn(logger, 'error');
    // The real ordering, and it needs a driver that answers on demand: the interval fires, the
    // heartbeat UPDATE is in flight, the body returns, `executeJob` acks the row out of
    // `running`, `worker-run.ts`'s `finally` calls `stop()` — and only THEN does the fenced
    // statement come back `false`, for a job that completed. `stop()` cleared the interval and
    // nothing else, so that answer took the `held === false` branch: `jobs.lease.lost` at ERROR
    // plus `recordLeaseLost`, which is a page for a non-event on the one signal that means the
    // queue re-delivered a job this process was still running.
    let land = (_held: boolean): void => undefined;
    const heartbeat = startLeaseHeartbeat({
      driver: {
        heartbeat: () =>
          new Promise<boolean>((resolve) => {
            land = resolve;
          }),
      },
      claimed,
      visibilityTimeoutMs: VISIBILITY_MS,
      intervalMs: 3_600_000,
      workerId: 'worker-1',
      clock: frozenClock(0),
    });

    void heartbeat.renew();
    heartbeat.stop();
    land(false);
    await Bun.sleep(1);

    const lost = error.mock.calls.filter((call) => call[0] === 'jobs.lease.lost');
    error.mockRestore();

    expect(lost).toEqual([]);
    expect(heartbeat.lost()).toBe(false);
    // And the run's signal is untouched: the body it would unwind has already finished.
    expect(heartbeat.signal.aborted).toBe(false);
    expect(lostCount('emails')).toBeUndefined();
  });
});

describe('the interval drives it without the test touching a timer', () => {
  test('a live lease renews on its own, and stop() really stops', async () => {
    let renewals = 0;
    const heartbeat = startLeaseHeartbeat({
      driver: {
        heartbeat: () => {
          renewals += 1;
          return Promise.resolve(true);
        },
      },
      claimed,
      visibilityTimeoutMs: VISIBILITY_MS,
      intervalMs: 1,
      workerId: 'worker-1',
      clock: frozenClock(0),
    });

    await Bun.sleep(20);
    heartbeat.stop();
    const armed = renewals;
    await Bun.sleep(20);

    expect(armed).toBeGreaterThan(0);
    expect(renewals).toBe(armed);
  });
});
