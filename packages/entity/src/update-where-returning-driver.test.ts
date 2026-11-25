// `updateWhereReturning` over a `defineDriver` store, which has no `returning`: what it answers is
// what THIS call wrote, and a result it could not hand back is refused before the store is called.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { integer, text, uuid } from './columns';
import { database } from './database';
import { defineDriver } from './define-driver';
import type { DriverRepo } from './driver-kit-types';
import { selectRows } from './driver-rows';
import { type EntityCore, entity } from './entity';
import type { EntityError } from './errors';
import { MAX_ASSERTED_ROWS } from './invariants';
import { clearRegistry } from './registry';

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const jobs = entity('uwrd_jobs', {
  columns: { id: uuid().primaryKey(), status: text({ max: 20 }), worker: text().nullable() },
});

const versioned = entity('uwrd_versioned', {
  columns: {
    id: uuid().primaryKey(),
    status: text({ max: 20 }),
    version: integer().default(0),
  },
  version: 'version',
});

type Job = typeof jobs.$row;

/** Runs once between the read of a filtered write and its `update`: the concurrent writer. */
let between: (() => void) | undefined;
let updates = 0;
const stores = new Map<string, Map<string, Record<string, unknown>>>();

const store = () =>
  defineDriver({
    name: 'map',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = new Map<string, Row>();
      stores.set(table.$name, rows as Map<string, Record<string, unknown>>);
      const idOf = (row: Row) => String((row as { id?: unknown }).id);
      return {
        select: async (read) => selectRows(table, rows.values(), read),
        count: async ({ plan }) =>
          selectRows(table, rows.values(), { plan, after: undefined, limit: rows.size }).length,
        insert: async (batch) => {
          for (const row of batch) rows.set(idOf(row), row);
          return batch;
        },
        update: async ({ plan }, patch) => {
          updates += 1;
          between?.();
          between = undefined;
          const hit = selectRows(table, rows.values(), {
            plan,
            after: undefined,
            limit: rows.size,
          });
          for (const row of hit) {
            const next = { ...row, ...patch } as Row;
            rows.delete(idOf(row));
            rows.set(idOf(next), next);
          }
          return hit.length;
        },
        delete: async () => 0,
      };
    },
  });

const job = (n: number, over: Partial<Job> = {}): Job => ({
  id: id(n),
  status: 'open',
  worker: null,
  ...over,
});

const caught = async (work: Promise<unknown>): Promise<EntityError | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) => error as EntityError,
  );

const move = (table: string, n: number, patch: Record<string, unknown>): void => {
  const rows = stores.get(table);
  rows?.set(id(n), { ...rows.get(id(n)), id: id(n), ...patch });
};

beforeEach(() => {
  between = undefined;
  updates = 0;
});
afterAll(() => {
  clearRegistry();
});

describe('updateWhereReturning on a custom store', () => {
  test('past the bound it is refused with the store untouched; updateWhere has no such bound', async () => {
    const db = database({ jobs }, { driver: store() });
    const rows = stores.get(jobs.$name);
    for (let n = 0; n <= MAX_ASSERTED_ROWS; n += 1) rows?.set(id(n), job(n));
    between = () => expect.unreachable('the store was called');
    const refused = await caught(db.jobs.updateWhereReturning({ status: 'open' }, { worker: 'w' }));
    between = undefined;
    expect(refused).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(String(refused?.cause)).toContain('.inBatches(1000)');
    expect(updates).toBe(0);
    expect(await db.jobs.updateWhere({ status: 'open' }, { worker: 'w' })).toBe(
      MAX_ASSERTED_ROWS + 1,
    );
  });

  test('a row that enters the filter after the read is neither written nor answered', async () => {
    const db = database({ jobs }, { driver: store() });
    await db.jobs.insertAll([job(1), job(2, { status: 'done' })]);
    // One leaves and one enters: the store's own count would still be the count it read.
    between = () => {
      move(jobs.$name, 1, { status: 'taken', worker: 'other' });
      move(jobs.$name, 2, { status: 'open', worker: null });
    };
    const rows = await db.jobs.updateWhereReturning({ status: 'open' }, { status: 'taken' });
    expect(rows).toEqual([]);
    expect((await db.jobs.where({ id: id(2) }).one())?.status).toBe('open');
  });

  test('a row another writer took leaves which rows were written unknown: refused, and it says so', async () => {
    const db = database({ jobs }, { driver: store() });
    await db.jobs.insertAll([job(1), job(2)]);
    between = () => move(jobs.$name, 1, { status: 'taken', worker: 'other' });
    const refused = await caught(
      db.jobs.updateWhereReturning({ status: 'open' }, { status: 'taken', worker: 'w' }),
    );
    expect(refused).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(String(refused?.cause)).toContain('wrote 1 of the 2 rows');
    expect(refused?.fix).toContain('before retrying');
  });

  test('a versioned row another writer took is left out, the rest answered', async () => {
    const db = database({ versioned }, { driver: store() });
    await db.versioned.insertAll([
      { id: id(1), status: 'open' },
      { id: id(2), status: 'open' },
    ]);
    between = () => move(versioned.$name, 1, { status: 'taken', version: 9 });
    const rows = await db.versioned.updateWhereReturning({ status: 'open' }, { status: 'taken' });
    expect(rows.map((row) => row.id)).toEqual([id(2)]);
  });

  test('a patch that moves the key answers the row under its new one', async () => {
    const db = database({ jobs }, { driver: store() });
    await db.jobs.insert(job(1));
    const rows = await db.jobs.updateWhereReturning({ id: id(1) }, { id: id(7) });
    expect(rows.map((row) => row.id)).toEqual([id(7)]);
  });
});
