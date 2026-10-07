// The operator-surface scenarios, written ONCE over a harness and run twice: on the memory driver
// (`operator-surface.test.ts`) and on the pg driver against a real Postgres
// (`operator-surface.job.test.ts`). This IS the parity suite for every member `JobIntrospection`
// grew — one assertion, two drivers, so neither can answer alone.

import { expect, test } from 'bun:test';
import type { Clock, Ctx, UltimateError } from '@ultimat3/core';
import { createContext, isUltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver, JobRecord, JobState } from './driver';
import type { JobIntrospection } from './introspection';
import { jobCursor, MAX_BULK_ROWS, MAX_JOB_PAGE } from './introspection';
import type { JobDefinition, JobHandle } from './job';
import { job } from './job';
import type { SchedulerState } from './scheduler-state';
import { memorySchedulerState } from './scheduler-state';
import type { Worker } from './worker';
import { createWorker } from './worker';

export interface SeedOptions {
  readonly name: string;
  readonly state: JobState;
  readonly count: number;
  readonly queue?: string;
}

export interface OperatorHarness {
  /** The ONE store a scenario's workers share, empty at the start of each test. */
  driver(): Promise<JobDriver>;
  /** Time passing as the queue sees it. Nothing is cleaned up by this. */
  elapse(driver: JobDriver, ms: number): Promise<void>;
  /** `count` rows already in `state`, written the fastest way the store allows. */
  seed(driver: JobDriver, options: SeedOptions): Promise<void>;
  /** The watermark store that pairs with this queue. */
  schedulerState(driver: JobDriver): Promise<SchedulerState>;
  readonly clock?: Clock;
}

export const TTL_MS = 30_000;

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

export function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

export interface ItemInput {
  readonly item: string;
}

let minted = 0;

/** A job named uniquely per call, so one scenario's counters are never another's. */
export function itemJob(
  definition: Partial<JobDefinition<ItemInput>> & Pick<JobDefinition<ItemInput>, 'run'>,
): JobHandle<ItemInput> {
  minted += 1;
  return job<ItemInput>({
    name: `operator-item-${minted}`,
    tenant: 'none',
    input: passthrough<ItemInput>(),
    idempotencyKey: ({ item }) => `item:${item}`,
    retry: { attempts: 1, jitter: false },
    ...definition,
  });
}

export function workerOn(
  harness: OperatorHarness,
  driver: JobDriver,
  workerId: string,
  queues: readonly string[] = ['default'],
): Worker {
  return createWorker({
    driver,
    workerId,
    queues,
    host: `host-of-${workerId}`,
    concurrency: 4,
    visibilityTimeoutMs: TTL_MS,
    heartbeatIntervalMs: 3_600_000,
    pollIntervalMs: 0,
    context,
    drainOnShutdown: false,
    ...(harness.clock === undefined ? {} : { clock: harness.clock }),
  });
}

let enqueued = 0;

export async function enqueueItem(
  driver: JobDriver,
  handle: JobHandle<ItemInput>,
  options: { readonly queue?: string; readonly runAt?: number } = {},
): Promise<string> {
  enqueued += 1;
  const { id } = await driver.enqueue({
    name: handle.name,
    queue: options.queue ?? 'default',
    input: { item: `i${enqueued}` },
    idempotencyKey: `item:${enqueued}`,
    maxAttempts: handle.retry.attempts,
    ...(options.runAt === undefined ? {} : { runAt: options.runAt }),
  });
  return id;
}

export function operatorOf(driver: JobDriver): JobIntrospection {
  if (driver.introspect === undefined) {
    return expect.unreachable(`the ${driver.name} driver ships no introspection`);
  }
  return driver.introspect;
}

export async function rowOf(driver: JobDriver, id: string): Promise<JobRecord> {
  const row = await operatorOf(driver).job(id);
  if (row === undefined) return expect.unreachable(`no job ${id} in the ${driver.name} driver`);
  return row;
}

const codeOf = async (attempt: Promise<unknown>): Promise<string | undefined> => {
  try {
    await attempt;
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
  return undefined;
};

/** The refusal itself, so a scenario reads its code, its cause and its fix off one value. */
const refusalOf = async (attempt: Promise<unknown>): Promise<UltimateError> => {
  try {
    await attempt;
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('expected a framework refusal');
};

/** Every page of a filter, walked by cursor, as ids in the order they were answered. */
async function walk(
  operator: JobIntrospection,
  name: string,
  limit: number,
  between?: () => Promise<void>,
): Promise<readonly string[]> {
  const seen: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1_000; page += 1) {
    const rows = await operator.list({ name, limit, ...(after === undefined ? {} : { after }) });
    seen.push(...rows.map((row) => row.id));
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < limit) return seen;
    after = jobCursor(last);
    await between?.();
  }
  return expect.unreachable('the walk never reached a short page');
}

export function operatorSurfaceScenarios(label: string, harness: OperatorHarness): void {
  test(`${label}: a paused queue is never claimed and still accepts enqueues`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const mailed = await enqueueItem(driver, handle, { queue: 'mail' });
    const other = await enqueueItem(driver, handle);
    const worker = workerOn(harness, driver, 'worker-a', ['mail', 'default']);

    await operator.pauseQueue('mail');
    await operator.pauseQueue('mail');
    expect((await operator.pausedQueues()).map((entry) => entry.name)).toEqual(['mail']);

    // The other queue drains; the paused one is not touched by any claim.
    expect((await worker.tick()).map((execution) => execution.jobId)).toEqual([other]);
    expect((await rowOf(driver, mailed)).state).toBe('ready');
    // Paused means not CLAIMED — work still lands, and is counted as waiting.
    const later = await enqueueItem(driver, handle, { queue: 'mail' });
    expect((await rowOf(driver, later)).state).toBe('ready');
    expect((await driver.stats()).find((queue) => queue.queue === 'mail')?.ready).toBe(2);

    await operator.resumeQueue('mail');
    expect(await operator.pausedQueues()).toEqual([]);
    expect((await worker.tick()).map((execution) => execution.jobId).sort()).toEqual(
      [mailed, later].sort(),
    );
  });

  test(`${label}: a keyset walk over 1,000 rows visits each once while rows are inserted`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    await harness.seed(driver, { name: handle.name, state: 'done', count: 1_000 });
    const before = new Set((await walk(operator, handle.name, MAX_JOB_PAGE)).map((id) => id));
    expect(before.size).toBe(1_000);

    // The same walk, with a row inserted between every two pages. A new row is NEWER than every
    // cursor, so it sorts before all of them: the walk neither repeats a row nor skips one.
    const inserted: string[] = [];
    const seen = await walk(operator, handle.name, 100, async () => {
      await harness.elapse(driver, 1);
      inserted.push(await enqueueItem(driver, handle));
    });

    expect(seen.length).toBe(new Set(seen).size);
    expect(new Set(seen)).toEqual(before);
    // Ten full pages, so ten inserts landed mid-walk — and not one of them was visited.
    expect(inserted.length).toBe(10);
    expect(seen.some((id) => inserted.includes(id))).toBe(false);
  });

  test(`${label}: a page is bounded, filtered by id prefix and by time, and a bad cursor is refused`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const first = await enqueueItem(driver, handle);
    await harness.elapse(driver, 60_000);
    const second = await enqueueItem(driver, handle);
    const newer = await rowOf(driver, second);

    expect((await operator.list({ name: handle.name })).map((row) => row.id)).toEqual([
      second,
      first,
    ]);
    expect((await operator.list({ idPrefix: first.slice(0, 13) })).map((row) => row.id)).toContain(
      first,
    );
    expect(
      (await operator.list({ name: handle.name, createdFrom: newer.createdAt })).map(
        (row) => row.id,
      ),
    ).toEqual([second]);
    expect(
      (await operator.list({ name: handle.name, createdTo: newer.createdAt })).map((row) => row.id),
    ).toEqual([first]);

    // A refusal a dashboard author can act on: the bound by name, and the call that walks.
    const tooMany = await refusalOf(operator.list({ limit: MAX_JOB_PAGE + 1 }));
    expect(tooMany.code).toBe('X_JOB_PAGE_INVALID');
    expect(String(tooMany.cause)).toContain(`limit is ${MAX_JOB_PAGE + 1}`);
    expect(String(tooMany.cause)).toContain(`MAX_JOB_PAGE (${MAX_JOB_PAGE})`);
    expect(tooMany.fix).toBe(`x jobs ls --limit ${MAX_JOB_PAGE} --json`);
    expect(tooMany.cause).toContain('after: jobCursor(lastRow)');
    const badCursor = await refusalOf(operator.list({ after: 'not-a-cursor' }));
    expect(badCursor.code).toBe('X_JOB_PAGE_INVALID');
    expect(badCursor.fix).toBe(`x jobs ls --limit ${MAX_JOB_PAGE} --json`);
    expect(badCursor.cause).toContain('an after cursor');
    // What the caller typed is not echoed: a cursor is input from the far side of a URL.
    expect(String(badCursor.cause)).not.toContain('not-a-cursor');
  });

  test(`${label}: removeMany stops at its bound and reports the remainder`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    await harness.seed(driver, { name: handle.name, state: 'dead', count: MAX_BULK_ROWS + 40 });
    const kept = await enqueueItem(driver, handle);

    const first = await operator.removeMany({ state: 'dead', name: handle.name });
    expect(first).toEqual({ affected: MAX_BULK_ROWS, remaining: 40 });
    const second = await operator.removeMany({ state: 'dead', name: handle.name });
    expect(second).toEqual({ affected: 40, remaining: 0 });
    // Only what the filter named: the ready row of the same job is untouched.
    expect((await rowOf(driver, kept)).state).toBe('ready');
    expect(await codeOf(operator.removeMany({ state: 'running' }))).toBe('X_JOB_NOT_REMOVABLE');
  });

  test(`${label}: requeueMany re-queues finished rows and leaves one whose key is live`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.reject(new TypeError('boom')) });
    const worker = workerOn(harness, driver, 'worker-a');
    const dead = [await enqueueItem(driver, handle), await enqueueItem(driver, handle)];
    await worker.tick();
    const blocked = await rowOf(driver, dead[0] ?? '');
    expect(blocked.state).toBe('dead');
    // A LIVE job takes the first dead row's key: requeueing that row would be two live rows of
    // one key, which the single requeue refuses as X_JOB_DUPLICATE.
    await driver.enqueue({
      name: handle.name,
      queue: 'default',
      input: { item: 'again' },
      idempotencyKey: blocked.idempotencyKey,
      maxAttempts: 1,
    });

    // The held row is not this verb's to move, so it is not "remaining" either.
    expect(await operator.requeueMany({ state: 'dead', name: handle.name })).toEqual({
      affected: 1,
      remaining: 0,
    });
    expect((await rowOf(driver, dead[0] ?? '')).state).toBe('dead');
    const requeued = await rowOf(driver, dead[1] ?? '');
    expect(requeued.state).toBe('ready');
    expect(requeued.attempt).toBe(0);
    expect(await codeOf(operator.requeueMany({ state: 'running' }))).toBe('X_INVARIANT');
  });

  test(`${label}: remove deletes a queued job and its steps, and refuses a running one`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const queued = await enqueueItem(driver, handle);
    const held = await enqueueItem(driver, handle);
    const queuedRow = await rowOf(driver, queued);
    await driver.steps.put({
      runId: queuedRow.runId,
      name: 'fetch',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      attempts: 1,
    });
    const [claimed] = (
      await driver.claim({
        queues: ['default'],
        limit: 5,
        visibilityTimeoutMs: TTL_MS,
        workerId: 'worker-a',
      })
    ).filter((row) => row.id === held);
    expect(claimed?.id).toBe(held);
    // `queued` was claimed in the same pass: hand it back so it is a queued row again.
    await driver.nack(queued, {
      workerId: 'worker-a',
      claim: 1,
      delayMs: 0,
      countsAsAttempt: false,
    });

    expect(await codeOf(operator.remove(held))).toBe('X_JOB_NOT_REMOVABLE');
    expect((await operator.remove(queued))?.id).toBe(queued);
    expect(await operator.job(queued)).toBeUndefined();
    expect(await driver.steps.list(queuedRow.runId)).toEqual([]);
    expect(await operator.remove(queued)).toBeUndefined();
  });

  test(`${label}: promote makes a delayed job due now, and nothing else`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const worker = workerOn(harness, driver, 'worker-a');
    const soon = await rowOf(driver, await enqueueItem(driver, handle));
    const delayed = await enqueueItem(driver, handle, { runAt: soon.runAt + 3_600_000 });

    expect((await rowOf(driver, delayed)).state).toBe('delayed');
    // Already due: there is no clock to move it past.
    expect(await operator.promote(soon.id)).toBeUndefined();
    expect(await operator.promote('019ff1c5-0000-7000-8000-00000000dead')).toBeUndefined();

    const promoted = await operator.promote(delayed);
    expect(promoted?.state).toBe('ready');
    expect((await worker.tick()).map((execution) => execution.jobId).sort()).toEqual(
      [soon.id, delayed].sort(),
    );
    expect(await operator.promote(delayed)).toBeUndefined();
  });
}

export { memorySchedulerState };
