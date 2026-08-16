// Direct coverage for `inspect.ts`, exercised elsewhere only indirectly through the CLI/MCP
// surfaces it feeds. Pins the totals arithmetic, the introspect-missing guard every read-side
// function shares, and the registeredJobs()/registeredTasks() cross-reference the manifest and
// job-trace shapes depend on.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assert, type UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { resetJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { JobsNotImplementedError } from './errors';
import {
  inspectDeadLetters,
  inspectJob,
  inspectJobList,
  inspectManifest,
  inspectQueues,
  retryFromStep,
} from './inspect';
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
  resetJobDriver();
});

afterEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
});

describe('inspectQueues', () => {
  test('sums per-queue stats into totals, and oldestReadyMs is the MAX across queues, not the sum', async () => {
    const driver = createMemoryDriver();
    // Every field below is a distinct value across the two queues and across fields within one
    // queue, so a swapped field (e.g. summing `ready` into the `delayed` slot) fails the exact
    // totals assertion instead of coincidentally matching — the source-level equivalent of a
    // mutation test, done without writing to a file outside this worker's set.
    const patched: JobDriver = {
      ...driver,
      stats: () =>
        Promise.resolve([
          {
            queue: 'default',
            ready: 2,
            delayed: 4,
            running: 6,
            suspended: 8,
            dead: 10,
            oldestReadyMs: 500,
          },
          {
            queue: 'emails',
            ready: 3,
            delayed: 5,
            running: 7,
            suspended: 9,
            dead: 11,
            oldestReadyMs: 1_200,
          },
        ]),
    };

    const report = await inspectQueues(patched);

    expect(report.driver).toBe('memory');
    expect(report.queues.length).toBe(2);
    expect(report.totals).toEqual({ ready: 5, delayed: 9, running: 13, suspended: 17, dead: 21 });
    // The max, never the sum (500 + 1200 = 1700 would also be wrong in the same direction).
    expect(report.oldestReadyMs).toBe(1_200);
  });

  test('a single queue: totals equal that queue, oldestReadyMs equals its own value', async () => {
    const driver = createMemoryDriver();
    const patched: JobDriver = {
      ...driver,
      stats: () =>
        Promise.resolve([
          {
            queue: 'default',
            ready: 1,
            delayed: 0,
            running: 0,
            suspended: 0,
            dead: 0,
            oldestReadyMs: 42,
          },
        ]),
    };

    const report = await inspectQueues(patched);

    expect(report.totals).toEqual({ ready: 1, delayed: 0, running: 0, suspended: 0, dead: 0 });
    expect(report.oldestReadyMs).toBe(42);
  });

  test('no queues at all: every total and oldestReadyMs is zero, not undefined or NaN', async () => {
    const driver = createMemoryDriver();
    const patched: JobDriver = { ...driver, stats: () => Promise.resolve([]) };

    const report = await inspectQueues(patched);

    expect(report.queues).toEqual([]);
    expect(report.totals).toEqual({ ready: 0, delayed: 0, running: 0, suspended: 0, dead: 0 });
    expect(report.oldestReadyMs).toBe(0);
  });
});

/** Drops `introspect` from a real memory driver — the type keeps it optional for exactly this. */
function driverWithoutIntrospect(): JobDriver {
  const full = createMemoryDriver();
  const { introspect: _introspect, ...rest } = full;
  return rest;
}

const INTROSPECT_FIX = "set jobs: { driver: 'postgres' } in app.config.ts, then: x jobs ls --json";

async function expectIntrospectionRequired(call: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await call();
  } catch (error) {
    thrown = error;
  }
  // Captured, then asserted — inside the `catch` a call that resolved would run no assertion at
  // all, and the guard under test is exactly the thing that must not silently let one through.
  expect(thrown).toBeInstanceOf(JobsNotImplementedError);
  const ultimateError = thrown as UltimateError;
  expect(ultimateError.code).toBe('X_NOT_IMPLEMENTED');
  expect(ultimateError.cause).toContain('introspection for the "memory" jobs driver');
  expect(ultimateError.fix).toBe(INTROSPECT_FIX);
}

describe('the introspect-missing guard, shared by every read-side function', () => {
  test('inspectJob throws X_NOT_IMPLEMENTED naming the driver', async () => {
    await expectIntrospectionRequired(() => inspectJob(driverWithoutIntrospect(), 'job-1'));
  });

  test('inspectJobList throws X_NOT_IMPLEMENTED naming the driver', async () => {
    await expectIntrospectionRequired(() => inspectJobList(driverWithoutIntrospect()));
  });

  test('inspectDeadLetters throws X_NOT_IMPLEMENTED naming the driver', async () => {
    await expectIntrospectionRequired(() => inspectDeadLetters(driverWithoutIntrospect()));
  });

  test('retryFromStep throws X_NOT_IMPLEMENTED naming the driver', async () => {
    await expectIntrospectionRequired(() => retryFromStep(driverWithoutIntrospect(), 'job-1'));
  });
});

/** Claims one enqueued job through a real memory driver, returning its (id, runId) pair. */
async function enqueueAndClaim(
  driver: JobDriver,
  overrides: { readonly name: string; readonly queue?: string },
): Promise<{ readonly id: string; readonly runId: string }> {
  const { id } = await driver.enqueue({
    name: overrides.name,
    queue: overrides.queue ?? 'default',
    input: { orgId: 'org-1' },
    idempotencyKey: `${overrides.name}:org-1`,
    maxAttempts: 3,
  });
  const [claimed] = await driver.claim({
    queues: [overrides.queue ?? 'default'],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'worker-1',
  });
  assert(
    claimed !== undefined,
    'the job enqueued for this case was not claimable, so the fixture never got a run id',
    'check the queue name passed to enqueueAndClaim matches the one claim() is polling',
  );
  return { id, runId: claimed.runId };
}

describe('inspectJob', () => {
  test('reads the record, its steps, and the retry schedule of the matching registered job', async () => {
    const driver = createMemoryDriver();
    const handle: JobHandle<OrgInput> = job<OrgInput>({
      tenant: 'none',
      name: 'sendDigest',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `digest:${orgId}`,
      retry: { attempts: 3, backoff: 'linear', delay: 1_000 },
      run: () => Promise.resolve(),
    });

    const { id, runId } = await enqueueAndClaim(driver, { name: handle.name });
    await driver.steps.put({
      runId,
      name: 'step-a',
      status: 'completed',
      startedAt: 1_000,
      completedAt: 1_500,
      attempts: 1,
    });

    const trace = await inspectJob(driver, id);

    expect(trace).toBeDefined();
    expect(trace?.id).toBe(id);
    expect(trace?.name).toBe('sendDigest');
    expect(trace?.state).toBe('running');
    expect(trace?.attempt).toBe(1);
    expect(trace?.maxAttempts).toBe(3);
    expect(trace?.idempotencyKey).toBe('sendDigest:org-1');
    expect(trace?.runId).toBe(runId);
    expect(trace?.steps.length).toBe(1);
    expect(trace?.steps[0]).toEqual({
      name: 'step-a',
      status: 'completed',
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(1_500).toISOString(),
      wakeAt: null,
      durationMs: 500,
      attempts: 1,
      error: null,
    });
    // linear backoff, delay 1000: attempt 1 -> 1000, attempt 2 -> 2000. retrySchedule() always
    // computes jitter-off, so this is exact regardless of the policy's own jitter setting.
    expect(trace?.retryDelaysMs).toEqual([1_000, 2_000]);
    // No backfill() pass wrote a row for this run, and the driver's ledger is empty.
    expect(trace?.backfill).toBeNull();
  });

  test('a record whose name matches no registered job gets an empty retry schedule, not a throw', async () => {
    const driver = createMemoryDriver();
    // Enqueued directly, never through job(): nothing in the registry is named this.
    const { id } = await enqueueAndClaim(driver, { name: 'an-unregistered-job-name' });

    const trace = await inspectJob(driver, id);

    expect(trace).toBeDefined();
    expect(trace?.name).toBe('an-unregistered-job-name');
    expect(trace?.retryDelaysMs).toEqual([]);
  });

  test('an id with no record returns undefined, not a throw', async () => {
    const driver = createMemoryDriver();
    const trace = await inspectJob(driver, 'no-such-job-id');
    expect(trace).toBeUndefined();
  });

  test('lastError and tenantId fall back to null when the record has neither', async () => {
    const driver = createMemoryDriver();
    const { id } = await enqueueAndClaim(driver, { name: 'plain-job' });
    const trace = await inspectJob(driver, id);
    expect(trace?.lastError).toBeNull();
    expect(trace?.tenantId).toBeNull();
  });
});

describe('inspectJobList', () => {
  test('is a thin passthrough to driver.introspect.list(filter)', async () => {
    const driver = createMemoryDriver();
    await driver.enqueue({
      name: 'jobA',
      queue: 'default',
      input: {},
      idempotencyKey: 'a',
      maxAttempts: 1,
    });
    await driver.enqueue({
      name: 'jobB',
      queue: 'default',
      input: {},
      idempotencyKey: 'b',
      maxAttempts: 1,
    });

    const all = await inspectJobList(driver);
    expect(all.length).toBe(2);

    const filtered = await inspectJobList(driver, { name: 'jobA' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.name).toBe('jobA');

    // Genuinely a passthrough: calling the driver directly agrees with the wrapper.
    const direct = await driver.introspect?.list({ name: 'jobB' });
    const viaInspect = await inspectJobList(driver, { name: 'jobB' });
    expect(viaInspect).toEqual(direct ?? []);
  });
});

describe('inspectDeadLetters', () => {
  test('maps driver rows to DeadLetterEntry and synthesizes the retry command', async () => {
    const driver = createMemoryDriver();
    const { id } = await enqueueAndClaim(driver, { name: 'flaky-job' });
    await driver.nack(id, { delayMs: 0, error: 'boom', deadLetter: true });

    const entries = await inspectDeadLetters(driver);

    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      id,
      name: 'flaky-job',
      queue: 'default',
      attempt: 1,
      lastError: 'boom',
      retryCommand: `x jobs retry ${id}`,
    });
    expect(typeof entries[0]?.failedAt).toBe('string');
  });

  test('limit is forwarded to the driver', async () => {
    const driver = createMemoryDriver();
    for (const name of ['a', 'b', 'c']) {
      const { id } = await enqueueAndClaim(driver, { name });
      await driver.nack(id, { delayMs: 0, deadLetter: true });
    }

    const entries = await inspectDeadLetters(driver, 2);
    expect(entries.length).toBe(2);
  });
});

describe('retryFromStep', () => {
  test('forwards { fromStep } only when a stepName is given, then re-reads the job', async () => {
    const driver = createMemoryDriver();
    const { id, runId } = await enqueueAndClaim(driver, { name: 'resumable-job' });
    await driver.steps.put({
      runId,
      name: 'step-a',
      status: 'completed',
      startedAt: 0,
      completedAt: 10,
      attempts: 1,
    });

    const calls: (readonly [string, { readonly fromStep?: string } | undefined])[] = [];
    const introspect = driver.introspect;
    assert(
      introspect !== undefined,
      'the memory driver came back without introspect, so there is nothing to spy on',
      "restore createMemoryDriver()'s introspect implementation",
    );
    const spied: JobDriver = {
      ...driver,
      introspect: {
        ...introspect,
        requeue: (jobId, options) => {
          calls.push([jobId, options]);
          return introspect.requeue(jobId, options);
        },
      },
    };

    await retryFromStep(spied, id, 'step-a');
    expect(calls[0]).toEqual([id, { fromStep: 'step-a' }]);

    await retryFromStep(spied, id);
    expect(calls[1]).toEqual([id, undefined]);
  });

  test('the returned trace reflects the requeue — state back to ready, attempt reset', async () => {
    const driver = createMemoryDriver();
    const { id } = await enqueueAndClaim(driver, { name: 'resumable-job-2' });

    const trace = await retryFromStep(driver, id);

    expect(trace).toBeDefined();
    expect(trace?.state).toBe('ready');
    expect(trace?.attempt).toBe(0);
  });
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
