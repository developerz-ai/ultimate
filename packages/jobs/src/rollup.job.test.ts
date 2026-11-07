// `rollup()` through the real execution path — enqueued, claimed and run by `executeJob`. Four
// guarantees: a late row inside `lookback` lands in its bucket on the next run, the first bucket is
// read from its own first instant (in its zone), a re-run changes nothing, and a run whose write
// fails leaves no half window behind. Plus the declaration refusals, raised where it was written.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  entity,
  integer,
  memoryRepo,
  tableFor,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import type { ClaimedJob, JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { DriverUnavailableError } from './errors';
import { executeJob } from './execute';
import type { JobExecution } from './execute-result';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import { type RollupTarget, rollup } from './rollup';

const likes = entity('rollup_job_likes', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), createdAt: timestamp() },
});
const daily = entity('rollup_job_daily', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), day: timestamp(), likes: integer() },
  indexes: [{ on: ['orgId', 'day'], unique: true }],
});
type Daily = typeof daily.$row;

const ORG = '00000000-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-11-06T12:00:00.000Z');
let serial = 0;
const nextId = (): string => {
  serial += 1;
  return `00000000-0000-7000-8000-${String(serial).padStart(12, '0')}`;
};

let driver: JobDriver;
let likesTable: ReturnType<typeof tableFor<typeof likes.$row, typeof likes.$columns>>;
let dailyTable: ReturnType<typeof tableFor<Daily, typeof daily.$columns>>;
/** The day a write fails on, once — INPUT to the code under test, never this test's verdict. */
let failOn: string | undefined;
/** What the table held when that write failed: a half window shows up here. */
let atFailure: readonly unknown[] | undefined;

const target = (): RollupTarget<Daily, Omit<Daily, 'id'> & { id: string }> => ({
  upsertAll: async (rows, args) => {
    const failing = failOn;
    if (failing !== undefined && rows.some((row) => row.day.toISOString() === failing)) {
      failOn = undefined;
      atFailure = await stored();
      throw new DriverUnavailableError({ driver: 'db', cause: 'blip', fix: 'retry' });
    }
    return dailyTable.upsertAll(rows, args);
  },
});

const declare = (name: string, timeZone = 'UTC') =>
  rollup({
    name,
    into: daily,
    table: target,
    key: ['orgId', 'day'],
    lookback: '2d',
    bucket: { unit: 'day', timeZone },
    tenant: (input) => input.orgId ?? ORG,
    retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: false },
    source: ({ since, bucket, input }) =>
      likesTable
        .where({ orgId: input.orgId ?? ORG })
        .andWhere('createdAt', 'gte', since)
        .series({ on: 'createdAt', ...bucket, value: 'count' }),
    map: (point, { input }) => ({
      id: nextId(),
      orgId: input.orgId ?? ORG,
      day: point.bucket,
      likes: point.value,
    }),
  });

const run = async (handle: AnyJobHandle, now = NOW): Promise<JobExecution[]> => {
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: { orgId: ORG },
    idempotencyKey: `rollup:${handle.name}:${ORG}:${serial}`,
    tenantId: ORG,
    maxAttempts: 3,
  });
  const executions: JobExecution[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [claimed] = await driver.claim({
      queues: [handle.queue],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    if (claimed === undefined) break;
    const ctx = ctxOf({
      role: 'worker',
      actor: userActor({ id: 'worker-1' }),
      clock: frozenClock(now),
    });
    executions.push(await executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx }));
  }
  return executions;
};

const like = (at: string) =>
  likesTable.insert({ id: nextId(), orgId: ORG, createdAt: new Date(at) });

const stored = async () =>
  (await dailyTable.where({ orgId: ORG }).orderBy('day').all()).map((row) => [
    row.day.toISOString(),
    row.likes,
  ]);

beforeEach(() => {
  resetJobs();
  likesTable = tableFor(likes, memoryRepo(likes, []));
  dailyTable = tableFor(daily, memoryRepo(daily, []));
  driver = memoryJobDriver();
  setJobDriver(driver);
  failOn = undefined;
  atFailure = undefined;
});

afterEach(() => {
  resetJobDriver();
});

afterAll(() => {
  resetJobs();
  clearRegistry();
});

describe('rollup run by executeJob', () => {
  test('a late row inside lookback lands; one outside it is the app’s choice to drop', async () => {
    const handle = declare('daily-likes-late') as AnyJobHandle;
    await like('2026-11-05T09:00:00.000Z');
    await like('2026-11-01T09:00:00.000Z');
    await run(handle);
    expect(await stored()).toEqual([['2026-11-05T00:00:00.000Z', 1]]);

    await like('2026-11-05T23:59:00.000Z');
    await like('2026-11-06T01:00:00.000Z');
    await run(handle);
    expect(await stored()).toEqual([
      ['2026-11-05T00:00:00.000Z', 2],
      ['2026-11-06T00:00:00.000Z', 1],
    ]);
  });

  test('a row early in the first bucket survives a re-run whose window opens mid-bucket', async () => {
    const handle = declare('daily-likes-first') as AnyJobHandle;
    await like('2026-11-04T09:00:00.000Z');
    await like('2026-11-04T15:00:00.000Z');
    await run(handle, new Date('2026-11-05T12:00:00.000Z'));
    expect(await stored()).toEqual([['2026-11-04T00:00:00.000Z', 2]]);
    // `now - lookback` is 2026-11-04T12:00Z, mid-bucket: the bucket is still read from midnight.
    const [rerun] = await run(handle);
    expect(rerun?.outcome).toBe('completed');
    expect(await stored()).toEqual([['2026-11-04T00:00:00.000Z', 2]]);
  });

  test('the first bucket opens at its own zone’s midnight, across a DST change', async () => {
    const handle = declare('daily-likes-berlin', 'Europe/Berlin') as AnyJobHandle;
    // 00:30 on 25 October in Berlin, still CEST (+02:00): its day opened at 22:00Z the day before.
    await like('2026-10-24T22:30:00.000Z');
    const [ran] = await run(handle, new Date('2026-10-27T12:00:00.000Z'));
    expect(ran?.result).toEqual({ since: '2026-10-24T22:00:00.000Z', rows: 1 });
    expect(await stored()).toEqual([['2026-10-24T22:00:00.000Z', 1]]);
  });

  test('a re-run over the same rows changes nothing', async () => {
    const handle = declare('daily-likes-rerun') as AnyJobHandle;
    await like('2026-11-05T09:00:00.000Z');
    await like('2026-11-06T09:00:00.000Z');
    await run(handle);
    const first = await dailyTable.where({ orgId: ORG }).orderBy('day').all();
    await run(handle);
    const second = await dailyTable.where({ orgId: ORG }).orderBy('day').all();
    expect(second.map((row) => [row.day, row.likes])).toEqual(
      first.map((row) => [row.day, row.likes]),
    );
    expect(second).toHaveLength(2);
  });

  test('a run whose write fails leaves no half window, and the retry lands all of it', async () => {
    const handle = declare('daily-likes-crash') as AnyJobHandle;
    await like('2026-11-05T09:00:00.000Z');
    await like('2026-11-06T09:00:00.000Z');
    failOn = '2026-11-06T00:00:00.000Z';
    const [failed] = await run(handle).then((runs) => [runs[0]]);
    expect(failed?.outcome).toBe('retried');
    expect(atFailure).toEqual([]);
    // The write is one call: the 2026-11-05 bucket was never written on its own.
    expect(await stored()).toEqual([
      ['2026-11-05T00:00:00.000Z', 1],
      ['2026-11-06T00:00:00.000Z', 1],
    ]);
  });
});

describe('what a rollup declaration may not hold', () => {
  const base = {
    into: daily,
    table: target,
    bucket: { unit: 'day', timeZone: 'UTC' } as const,
    tenant: 'none' as const,
    source: async () => [],
    map: () => ({ id: nextId(), orgId: ORG, day: NOW, likes: 0 }),
  };

  test('no lookback', () => {
    expect(() =>
      rollup({
        ...base,
        name: 'r-none',
        key: ['orgId', 'day'],
        lookback: undefined as unknown as string,
      }),
    ).toThrow(expect.objectContaining({ code: 'X_JOB_ROLLUP_INVALID' }));
  });

  test('a lookback that is no window', () => {
    expect(() => rollup({ ...base, name: 'r-zero', key: ['orgId', 'day'], lookback: 0 })).toThrow(
      expect.objectContaining({ code: 'X_JOB_ROLLUP_INVALID' }),
    );
  });

  test('no bucket', () => {
    expect(() =>
      rollup({
        ...base,
        name: 'r-no-bucket',
        key: ['orgId', 'day'],
        lookback: '1d',
        bucket: undefined as unknown as { unit: 'day'; timeZone: string },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_JOB_ROLLUP_INVALID' }));
  });

  test('a bucket unit no series has', () => {
    expect(() =>
      rollup({
        ...base,
        name: 'r-unit',
        key: ['orgId', 'day'],
        lookback: '1d',
        bucket: { unit: 'fortnight' as 'day', timeZone: 'UTC' },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_JOB_ROLLUP_INVALID' }));
  });

  test('a bucket zone that is no IANA zone', () => {
    expect(() =>
      rollup({
        ...base,
        name: 'r-zone',
        key: ['orgId', 'day'],
        lookback: '1d',
        bucket: { unit: 'day', timeZone: 'EST' },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_JOB_ROLLUP_INVALID' }));
  });

  test('a key no unique constraint covers', () => {
    expect(() => rollup({ ...base, name: 'r-key', key: ['day'], lookback: '1d' })).toThrow(
      expect.objectContaining({ code: 'X_JOB_ROLLUP_INVALID' }),
    );
  });

  test('an empty key', () => {
    expect(() => rollup({ ...base, name: 'r-empty', key: [], lookback: '1d' })).toThrow(
      expect.objectContaining({ code: 'X_JOB_ROLLUP_INVALID' }),
    );
  });

  test('the primary key is a unique constraint too', () => {
    expect(rollup({ ...base, name: 'r-pk', key: ['id'], lookback: '1d' }).name).toBe('r-pk');
  });
});
