// A renewal that answers "not yours" has two causes, and only one is a lost lease. An operator's or
// an app's `cancel` writes `cancelled` on a running row ON PURPOSE, and the next renewal missing it
// is how the attempt hears to stop — the designed path, not a failure of the queue. Reported as
// `jobs.lease.lost` at error with `job_leases_lost_total` counted, it buried the one signal that
// means "this job may now run twice" (a production app: 111 of 168 "losses" in 24 h were its
// callers' stops). Told apart by reading the row once, on that rare branch only.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { collectMetrics, frozenClock, logger, resetMetrics } from '@ultimat3/core';
import type { ClaimedJob, JobRecord } from './driver';
import { startLeaseHeartbeat } from './heartbeat';

const claimed: ClaimedJob = {
  id: 'job-1',
  name: 'scrape',
  queue: 'banks',
  input: {},
  idempotencyKey: 'scrape:1',
  runId: 'run-1',
  attempt: 1,
  maxAttempts: 3,
  state: 'running',
  runAt: 0,
  createdAt: 0,
  updatedAt: 0,
  claimedAt: 0,
  visibleAt: 30_000,
  claimedBy: 'worker-1',
  claim: 1,
};

const lostCount = (): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === 'job_leases_lost_total')
    ?.points.find((point) => point.attributes['queue'] === 'banks')?.value;

function notOurs(row: () => Promise<Partial<JobRecord> | undefined>) {
  return startLeaseHeartbeat({
    driver: {
      heartbeat: () => Promise.resolve(false),
      introspect: { job: async () => (await row()) as JobRecord | undefined },
    },
    claimed,
    visibilityTimeoutMs: 30_000,
    intervalMs: 3_600_000,
    workerId: 'worker-1',
    clock: frozenClock(0),
  });
}

afterEach(() => {
  resetMetrics();
});

describe('a renewal the row refuses', () => {
  test('cancelled: the attempt stops, said at info, never counted as a lost lease', async () => {
    const error = spyOn(logger, 'error');
    const info = spyOn(logger, 'info');
    try {
      const heartbeat = notOurs(() => Promise.resolve({ state: 'cancelled' }));
      await heartbeat.renew();
      expect(heartbeat.signal.aborted).toBe(true);
      expect(error.mock.calls.filter((call) => call[0] === 'jobs.lease.lost')).toEqual([]);
      expect(info.mock.calls.find((call) => call[0] === 'jobs.lease.cancelled')?.[1]).toMatchObject(
        { jobId: 'job-1', queue: 'banks', workerId: 'worker-1' },
      );
      expect(lostCount()).toBeUndefined();
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });

  test('re-claimed by another worker: still a lost lease, at error, counted', async () => {
    const error = spyOn(logger, 'error');
    try {
      const heartbeat = notOurs(() =>
        Promise.resolve({ state: 'running', claimedBy: 'worker-2', claim: 2 }),
      );
      await heartbeat.renew();
      expect(heartbeat.signal.aborted).toBe(true);
      expect(error.mock.calls.find((call) => call[0] === 'jobs.lease.lost')?.[1]).toMatchObject({
        reason: 'not-ours',
      });
      expect(lostCount()).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  test('a row that cannot be read is not assumed cancelled', async () => {
    const heartbeat = notOurs(() => Promise.reject(new Error('pool exhausted')));
    await heartbeat.renew();
    expect(heartbeat.signal.aborted).toBe(true);
    expect(lostCount()).toBe(1);
  });
});
