// `inspectManifest()` — the registered jobs and tasks as generated facts. Split off
// `inspect.test.ts` at the file-size ceiling: that file is the queue's read side, this is the
// registry's projection, and neither needs a driver the other builds.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { inspectManifest } from './inspect';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import type { Scheduler } from './scheduler';
import { resetTasks, task } from './task';

/** Minimal Standard Schema so these tests do not depend on the shipped provider's surface. */
function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface OrgInput {
  readonly orgId: string;
}

beforeEach(() => {
  resetJobs();
  resetTasks();
});

afterEach(() => {
  resetJobs();
  resetTasks();
});

describe('inspectManifest', () => {
  test('with no scheduler: jobs and tasks are mapped, and every task nextRun is null', () => {
    const digest: JobHandle<OrgInput> = job<OrgInput>({
      tenant: 'none',
      name: 'sendDigest',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `digest:${orgId}`,
      retry: { attempts: 3, backoff: 'linear', delay: 1_000 },
      concurrency: 5,
      timeout: 30_000,
      run: () => Promise.resolve(),
    });
    task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      catchUp: 'run-once',
      enqueue: () => [[digest, { orgId: 'org-1' }]],
    });

    const manifest = inspectManifest();

    expect(manifest.jobs).toEqual([
      {
        name: 'sendDigest',
        queue: 'default',
        attempts: 3,
        backoff: 'linear',
        concurrency: 5,
        whenBusy: null,
        onSettled: false,
        timeoutMs: 30_000,
        retryDelaysMs: [1_000, 2_000],
      },
    ]);
    expect(manifest.tasks.length).toBe(1);
    expect(manifest.tasks[0]).toEqual({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      catchUp: 'run-once',
      nextRun: null,
      enqueues: ['sendDigest'],
    });
  });

  test('omitted job fields (no concurrency, no timeout) come through as null, not undefined', () => {
    job<OrgInput>({
      tenant: 'none',
      name: 'plainJob',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `plain:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    const manifest = inspectManifest();

    expect(manifest.jobs[0]?.concurrency).toBeNull();
    expect(manifest.jobs[0]?.timeoutMs).toBeNull();
    // attempts: 1 means never retries — the schedule is empty.
    expect(manifest.jobs[0]?.retryDelaysMs).toEqual([]);
    // Omitted backoff still reports the handle's own default, 'exponential'.
    expect(manifest.jobs[0]?.backoff).toBe('exponential');
  });

  test('with a scheduler: nextRun is populated from scheduler.nextRunFor(handle)', () => {
    const digest: JobHandle<OrgInput> = job<OrgInput>({
      tenant: 'none',
      name: 'sendDigest',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `digest:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[digest, { orgId: 'org-1' }]],
    });

    const fixedNextRun = new Date('2026-01-02T03:00:00.000Z');
    // Minimal fake: only `nextRunFor` is read by inspectManifest, but the type is the full
    // Scheduler surface, so every method is present.
    const fakeScheduler: Scheduler = {
      start: () => undefined,
      stop: () => Promise.resolve(),
      tick: () => Promise.resolve([]),
      nextRunFor: () => fixedNextRun,
    };

    const manifest = inspectManifest(fakeScheduler);

    expect(manifest.tasks[0]?.nextRun).toBe(fixedNextRun.toISOString());
  });
});
