// `onSettled`: the one hook a job declares to learn how a run ENDED — completed with its result,
// dead-lettered, dropped or refused. After the row is settled, in the job's tenant scope, on its
// own tries, and never able to change what the queue recorded.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, frozenClock, logger, useContext } from '@ultimat3/core';
import type { JobDriver, JobRecord } from './driver';
import { memoryJobDriver } from './driver-memory';
import { cancelJob } from './inspect';
import type { JobDefinition, JobHandle } from './job';
import { job, resetJobs } from './job';
import { passthrough } from './operator-surface-fixture';
import type { JobSettled } from './settled';
import { ON_SETTLED_ATTEMPTS } from './settled';
import type { Worker } from './worker';
import { jobWorker } from './worker';

const clock = frozenClock('2026-10-01T00:00:30.000Z');
const ORG = '00000000-0000-4000-8000-0000000000a1';

interface SyncInput {
  readonly account: string;
  readonly orgId: string;
}

interface Report {
  readonly rows: number;
}

let minted = 0;

const syncJob = <R>(
  definition: Partial<JobDefinition<SyncInput, R>> & Pick<JobDefinition<SyncInput, R>, 'run'>,
): JobHandle<SyncInput> => {
  minted += 1;
  return job<SyncInput, R>({
    name: `settled-sync-${minted}`,
    tenant: ({ orgId }) => orgId,
    input: passthrough<SyncInput>(),
    idempotencyKey: ({ account }) => `sync:${account}`,
    retry: { attempts: 1, jitter: false },
    ...definition,
  });
};

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

const workerOn = (driver: JobDriver, workerId: string, heartbeatMs = 3_600_000): Worker =>
  jobWorker({
    driver,
    workerId,
    // One slot: a pass claims one run, so the second run is the OTHER worker's to refuse.
    concurrency: 1,
    visibilityTimeoutMs: 30_000,
    heartbeatIntervalMs: heartbeatMs,
    pollIntervalMs: 0,
    context,
    drainOnShutdown: false,
    clock,
  });

let enqueued = 0;
const enqueue = async (driver: JobDriver, handle: JobHandle<SyncInput>, account = 'acct-1') => {
  enqueued += 1;
  return driver.enqueue({
    name: handle.name,
    queue: 'default',
    input: { account, orgId: ORG },
    idempotencyKey: `sync:${enqueued}`,
    maxAttempts: handle.retry.attempts,
  });
};

const rowOf = async (driver: JobDriver, id: string): Promise<JobRecord> =>
  (await driver.introspect?.job(id)) ?? expect.unreachable(`no job ${id}`);

afterEach(() => {
  resetJobs();
});

describe('onSettled', () => {
  test('a completed run hands over what the body returned, after the row is done', async () => {
    const driver = memoryJobDriver({ clock });
    const seen: { settled: JobSettled<SyncInput, Report>; rowState: string; org: unknown }[] = [];
    const handle = syncJob<Report>({
      run: () => Promise.resolve({ rows: 7 }),
      async onSettled(settled) {
        seen.push({
          settled,
          rowState: (await rowOf(driver, settled.jobId)).state,
          // The body's own scope: the tenant the job DECLARED is on the ambient actor.
          org: useContext().actor.orgId,
        });
      },
    });
    const { id, runId } = await enqueue(driver, handle);

    const [execution] = await workerOn(driver, 'worker-a').tick();

    expect(execution?.outcome).toBe('completed');
    // The same value, for the caller that drove the run by hand (`@ultimat3/testing`).
    expect(execution?.result).toEqual({ rows: 7 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.rowState).toBe('done');
    expect(seen[0]?.org).toBe(ORG);
    expect(seen[0]?.settled).toMatchObject({
      outcome: 'completed',
      result: { rows: 7 },
      input: { account: 'acct-1', orgId: ORG },
      attempt: 1,
      jobId: id,
      runId,
    });
    expect(handle.describe().onSettled).toBe(true);
  });

  test('a retry and a suspension are not settlements; the dead letter is, with its code', async () => {
    const driver = memoryJobDriver({ clock });
    const seen: JobSettled<SyncInput, unknown>[] = [];
    const handle = syncJob({
      retry: { attempts: 2, jitter: false, delay: 1, backoff: 'fixed' },
      run: async ({ step, attempt }) => {
        if (attempt === 1) throw new TypeError('the site is down');
        await step.sleep('nap', 1_000);
        throw new TypeError('the site is still down');
      },
      onSettled: (settled) => {
        seen.push(settled);
        return Promise.resolve();
      },
    });
    const { id } = await enqueue(driver, handle);
    const worker = workerOn(driver, 'worker-a');

    expect((await worker.tick()).map((run) => run.outcome)).toEqual(['retried']);
    clock.advance(5_000);
    expect((await worker.tick()).map((run) => run.outcome)).toEqual(['suspended']);
    expect(seen).toEqual([]);
    clock.advance(5_000);
    expect((await worker.tick()).map((run) => run.outcome)).toEqual(['dead-lettered']);

    expect(seen).toHaveLength(1);
    const [settled] = seen;
    if (settled?.outcome !== 'dead-lettered') return expect.unreachable('expected a dead letter');
    expect(settled.error).toContain('the site is still down');
    // A throw with no `X_*` code of its own carries none: the hook never invents one.
    expect(settled.code).toBeUndefined();
    expect((await rowOf(driver, id)).state).toBe('dead');
  });

  test('a dropped run says so, and a coded failure carries its code', async () => {
    const driver = memoryJobDriver({ clock });
    const seen: JobSettled<SyncInput, unknown>[] = [];
    const handle = syncJob({
      retry: { attempts: 1, jitter: false, deadLetter: false },
      // A parse refusal is the framework's own coded error — and it leaves no input behind.
      input: {
        '~standard': {
          version: 1,
          vendor: 'ultimate-test',
          validate: () => ({ issues: [{ message: 'account is required' }] }),
        },
      },
      run: () => Promise.resolve(),
      onSettled: (settled) => {
        seen.push(settled);
        return Promise.resolve();
      },
    });
    await enqueue(driver, handle);

    expect((await workerOn(driver, 'worker-a').tick()).map((run) => run.outcome)).toEqual([
      'dropped',
    ]);
    expect(seen).toHaveLength(1);
    const [settled] = seen;
    if (settled?.outcome !== 'dropped') return expect.unreachable('expected a dropped run');
    expect(settled.code).toMatch(/^X_[A-Z_]+$/);
    // The stored payload did not parse, which is why it died: there is no input to hand over.
    expect(settled.input).toBeUndefined();
  });

  test('a run its concurrency key refused is settled too — the body never ran', async () => {
    const driver = memoryJobDriver({ clock });
    const seen: JobSettled<SyncInput, unknown>[] = [];
    const gate = Promise.withResolvers<void>();
    let started = 0;
    const handle = syncJob({
      concurrency: { key: ({ account }) => account, limit: 1, whenBusy: 'fail' },
      run: async () => {
        started += 1;
        await gate.promise;
      },
      onSettled: (settled) => {
        seen.push(settled);
        return Promise.resolve();
      },
    });
    await enqueue(driver, handle);
    const second = await enqueue(driver, handle);

    const holding = workerOn(driver, 'worker-a').tick();
    while (started === 0) await Promise.resolve();
    const refused = await workerOn(driver, 'worker-b').tick();

    expect(refused.map((run) => run.outcome)).toEqual(['refused']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      outcome: 'refused',
      code: 'X_JOB_KEY_BUSY',
      jobId: second.id,
      runId: second.runId,
      input: { account: 'acct-1', orgId: ORG },
    });
    gate.resolve();
    await holding;
    expect(seen.map((settled) => settled.outcome)).toEqual(['refused', 'completed']);
    expect(started).toBe(1);
  });

  test('a run cancelled under its body is not this worker’s to announce', async () => {
    const driver = memoryJobDriver({ clock });
    const seen: JobSettled<SyncInput, unknown>[] = [];
    const gate = Promise.withResolvers<void>();
    let started = 0;
    const handle = syncJob({
      run: async () => {
        started += 1;
        await gate.promise;
      },
      onSettled: (settled) => {
        seen.push(settled);
        return Promise.resolve();
      },
    });
    const { id } = await enqueue(driver, handle);
    const holding = workerOn(driver, 'worker-a').tick();
    while (started === 0) await Promise.resolve();

    await cancelJob(driver, id, 'cancelled by the test');
    gate.resolve();
    await holding;

    // The ack matched nothing: the row is `cancelled`, and whoever cancelled it is the observer.
    expect((await rowOf(driver, id)).state).toBe('cancelled');
    expect(seen).toEqual([]);
  });

  test('a hook that throws spends its own tries, is logged with a code, and changes nothing', async () => {
    const driver = memoryJobDriver({ clock });
    let calls = 0;
    const handle = syncJob({
      run: () => Promise.resolve('done'),
      onSettled: () => {
        calls += 1;
        return Promise.reject(new TypeError('webhook unreachable'));
      },
    });
    const { id } = await enqueue(driver, handle);
    const errors = spyOn(logger, 'error');

    const executions = await workerOn(driver, 'worker-a').tick();
    const logged = errors.mock.calls.filter((call) => call[0] === 'jobs.on-settled.failed');
    errors.mockRestore();

    // The run COMPLETED, and still did: a reaction that fails is not the job failing.
    expect(executions.map((run) => run.outcome)).toEqual(['completed']);
    expect((await rowOf(driver, id)).state).toBe('done');
    expect(calls).toBe(ON_SETTLED_ATTEMPTS);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[1]).toMatchObject({
      code: 'X_JOB_ON_SETTLED_FAILED',
      outcome: 'completed',
      fix: `x jobs show ${id} --json`,
    });
  });

  test('a job that declares no hook publishes that it has none', () => {
    const handle = syncJob({ run: () => Promise.resolve() });
    expect(handle.describe().onSettled).toBe(false);
    expect(handle.declaresOnSettled).toBe(false);
  });
});
