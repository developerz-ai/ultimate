// `jobStatusFor` / `cancelJobFor` on the memory driver — the shared scenarios, then what only a
// unit can reach: progress, the refusal of a driver with no fence, and a driver answering more
// columns than the status may show.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { cancelJobFor, jobStatusFor } from './job-status';
import { jobStatusScenarios } from './job-status-fixture';

describe('a tenant reads and cancels its own job, on the memory driver', () => {
  jobStatusScenarios('memory', {
    driver: () => Promise.resolve(memoryJobDriver({ clock: frozenClock('2026-11-27T00:00:00Z') })),
  });
});

describe('jobStatusFor', () => {
  test('answers the progress the body last reported', async () => {
    const driver = memoryJobDriver();
    const { id } = await driver.enqueue({
      name: 'report.build',
      queue: 'default',
      input: {},
      idempotencyKey: 'p',
      maxAttempts: 1,
      tenantId: 'org-a',
    });
    const [held] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    });
    if (held === undefined) return expect.unreachable('the fresh row was claimable');
    const progress = { done: 3, total: 10, note: 'page 3', at: 1_000 };
    await driver.introspect?.recordProgress(id, { workerId: 'w', claim: held.claim }, progress);
    const status = await jobStatusFor(driver, { jobId: id, tenantId: 'org-a' });
    expect(status?.progress).toEqual(progress);
    expect(status?.state).toBe('running');
  });

  test('a driver with no tenant fence is refused, never read around', async () => {
    const { tenantJobs: _fence, ...bare } = memoryJobDriver();
    const driver: JobDriver = bare;
    const query = { jobId: '019ff1c5-0000-7000-8000-00000000dead', tenantId: 'org-a' };
    await expect(jobStatusFor(driver, query)).rejects.toMatchObject({
      code: 'X_JOB_INTROSPECTION_UNSUPPORTED',
    });
    await expect(cancelJobFor(driver, query)).rejects.toMatchObject({
      code: 'X_JOB_INTROSPECTION_UNSUPPORTED',
    });
  });

  test('a column a driver answers beyond the status never reaches the caller', async () => {
    const leaky = {
      id: '019ff1c5-0000-7000-8000-00000000beef',
      name: 'report.build',
      state: 'dead',
      attempt: 3,
      maxAttempts: 3,
      runAt: 0,
      createdAt: 0,
      updatedAt: 0,
      input: { secret: 'sk_live' },
      lastError: 'boom',
      lastErrorStack: 'at secret.ts:1',
      traceparent: '00-abc',
    } as const;
    const driver: JobDriver = {
      ...memoryJobDriver(),
      tenantJobs: { status: () => Promise.resolve(leaky), cancel: () => Promise.resolve(leaky) },
    };
    const query = { jobId: leaky.id, tenantId: 'org-a' };
    for (const status of [await jobStatusFor(driver, query), await cancelJobFor(driver, query)]) {
      expect(status).not.toHaveProperty('input');
      expect(status).not.toHaveProperty('lastError');
      expect(status).not.toHaveProperty('lastErrorStack');
      expect(status).not.toHaveProperty('traceparent');
      expect(status?.state).toBe('dead');
    }
  });

  test('an empty reason reaches no driver: every one keeps the lastError it had', async () => {
    const reasons: (string | undefined)[] = [];
    const row = {
      id: '019ff1c5-0000-7000-8000-00000000beef',
      name: 'report.build',
      state: 'cancelled',
      attempt: 0,
      maxAttempts: 1,
      runAt: 0,
      createdAt: 0,
      updatedAt: 0,
    } as const;
    const driver: JobDriver = {
      ...memoryJobDriver(),
      tenantJobs: {
        status: () => Promise.resolve(row),
        cancel: (_query, reason) => {
          reasons.push(reason);
          return Promise.resolve(row);
        },
      },
    };
    const query = { jobId: row.id, tenantId: 'org-a' };
    await cancelJobFor(driver, { ...query, reason: '' });
    await cancelJobFor(driver, { ...query, reason: 'by ada' });
    expect(reasons).toEqual([undefined, 'by ada']);
  });
});
