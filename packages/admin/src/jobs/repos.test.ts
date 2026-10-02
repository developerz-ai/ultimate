// The four jobs repos as an `AdminRepo` must behave: a page in the asked order, keyset both ways,
// a count, a row by key — and the door to the queue refusing a process that installed none.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type JobDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import type { AdminRow } from '../registry';
import { fleetRepo, queueRepo, taskRepo, workerRepo } from './fleet-repo';
import { jobRepo } from './job-repo';
import { type Seeded, seedQueue } from './jobs-fixture';
import { jobsOperator } from './operator';

let seeded: Seeded;

beforeAll(async () => {
  seeded = await seedQueue();
});

afterAll(() => {
  resetJobDriver();
});

const rows: readonly AdminRow[] = [
  { name: 'b', depth: 2, at: new Date(2), paused: true },
  { name: 'a', depth: 3, at: new Date(3), paused: false },
  { name: 'c', depth: 1, at: new Date(1), paused: false },
  { name: 'd', depth: null, at: new Date(4), paused: true },
];
const repo = fleetRepo('name', () => Promise.resolve(rows));
const names = (list: readonly AdminRow[]) => list.map((row) => row['name']);

describe('fleetRepo', () => {
  test('orders by the asked field, either way, by code unit, the key breaking ties', async () => {
    expect(names(await repo.list({ sort: { field: 'name', direction: 'asc' }, limit: 9 }))).toEqual(
      ['a', 'b', 'c', 'd'],
    );
    expect(
      names(await repo.list({ sort: { field: 'depth', direction: 'desc' }, limit: 2 })),
    ).toEqual(['a', 'b']);
    expect(
      names(await repo.list({ sort: { field: 'paused', direction: 'asc' }, limit: 9 })),
    ).toEqual(['a', 'c', 'b', 'd']);
  });

  test('a keyset page after a bound, and the page before it, in the same order', async () => {
    const sort = { field: 'at', direction: 'asc' } as const;
    const after = await repo.list({
      sort,
      limit: 2,
      after: { field: 'at', value: new Date(2).toISOString(), id: 'b' },
    });
    expect(names(after)).toEqual(['a', 'd']);
    const before = await repo.list({
      sort,
      limit: 1,
      before: { field: 'at', value: new Date(3).toISOString(), id: 'a' },
    });
    expect(names(before)).toEqual(['b']);
    const flags = await repo.list({
      sort: { field: 'paused', direction: 'asc' },
      limit: 9,
      after: { field: 'paused', value: 'false', id: 'c' },
    });
    expect(names(flags)).toEqual(['b', 'd']);
  });

  test('filters through the package’s one evaluator, counts, and finds by key', async () => {
    const where = [{ field: 'paused', op: 'eq', value: true }] as const;
    expect(await repo.count?.(where)).toBe(2);
    expect(
      names(await repo.list({ where, sort: { field: 'name', direction: 'asc' }, limit: 9 })),
    ).toEqual(['b', 'd']);
    expect(await repo.find('c')).toMatchObject({ depth: 1 });
    expect(await repo.find('zz')).toBeNull();
  });

  test('a write is an invariant, not an operation it offers', async () => {
    const codes = await Promise.all(
      [repo.create({}), repo.update('a', {}), repo.destroy('a'), jobRepo.destroy('x')].map((p) =>
        p.then(
          () => 'ran',
          (error: unknown) => (isUltimateError(error) ? error.code : 'other'),
        ),
      ),
    );
    expect(codes).toEqual(['X_INVARIANT', 'X_INVARIANT', 'X_INVARIANT', 'X_INVARIANT']);
  });
});

describe('the queue, the tasks, the workers and the runs as rows', () => {
  test('every queue a job names, with its depth and its pause', async () => {
    await seeded.operator.pauseQueue('mail');
    const queues = await queueRepo.list({ sort: { field: 'name', direction: 'asc' }, limit: 9 });
    expect(queues.map((row) => [row['name'], row['paused']])).toEqual([
      ['default', false],
      ['mail', true],
    ]);
    expect(queues[0]).toMatchObject({ dead: 1, delayed: 1, running: 1 });
    await seeded.operator.resumeQueue('mail');
  });

  test('a task carries its next fire in its own zone, and a worker its in-flight count', async () => {
    const task = await taskRepo.find(seeded.task);
    expect(task?.['nextFireAt']).toBeInstanceOf(Date);
    expect(task?.['lastFireAt']).toBeNull();
    expect((await workerRepo.find('worker-1'))?.['inFlight']).toBe(1);
  });

  test('a run page is newest first; an exact id is checked on the row; the page before a cursor', async () => {
    const sort = { field: 'createdAt', direction: 'desc' } as const;
    const page = await jobRepo.list({ sort, limit: 3 });
    expect(page).toHaveLength(3);
    const exact = await jobRepo.list({
      sort,
      limit: 5,
      where: [{ field: 'id', op: 'eq', value: seeded.ids.dead }],
    });
    expect(exact.map((row) => row['id'])).toEqual([seeded.ids.dead]);
    const second = page[1] ?? expect.unreachable('a page of three has a second row');
    const back = await jobRepo.list({
      sort,
      limit: 5,
      before: {
        field: 'createdAt',
        value: (second['createdAt'] as Date).toISOString(),
        id: String(second['id']),
      },
    });
    expect(back.map((row) => row['id'])).toEqual([page[0]?.['id']]);
    expect(
      await jobRepo.list({
        sort,
        limit: 5,
        where: [
          { field: 'state', op: 'eq', value: 'dead' },
          { field: 'state', op: 'eq', value: 'done' },
        ],
      }),
    ).toEqual([]);
    // An id the store matches by prefix is held to the WHOLE id on the row: `j-1` is not `j-10`.
    for (const id of ['j-1', 'j-10']) {
      await seeded.driver.enqueue({
        id,
        name: seeded.name,
        queue: 'default',
        input: { item: id },
        idempotencyKey: `exact-${id}`,
        maxAttempts: 1,
      });
    }
    const one = await jobRepo.list({
      sort,
      limit: 5,
      where: [{ field: 'id', op: 'eq', value: 'j-1' }],
    });
    expect(one.map((row) => row['id'])).toEqual(['j-1']);
  });
});

describe('jobsOperator', () => {
  test('a process with no queue, or a queue with no operator surface, is refused with the fix', () => {
    const codeOf = (): string | undefined => {
      try {
        jobsOperator();
      } catch (error) {
        return isUltimateError(error) ? error.code : 'other';
      }
      return undefined;
    };
    resetJobDriver();
    expect(codeOf()).toBe('X_DRIVER_UNAVAILABLE');
    const { introspect: _dropped, ...bare } = seeded.driver;
    setJobDriver(bare as JobDriver);
    expect(codeOf()).toBe('X_NOT_IMPLEMENTED');
    setJobDriver(seeded.driver);
    expect(jobsOperator().driver).toBe(seeded.driver);
  });
});
