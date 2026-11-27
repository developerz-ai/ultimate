// A count-only custom store cannot identify the rows it wrote under concurrency, so it refuses
// returning writes before mutation while retaining count-only updates.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { database } from './database';
import { defineDriver } from './define-driver';
import type { DriverRepo } from './driver-kit-types';
import { selectRows } from './driver-rows';
import { type EntityCore, entity } from './entity';
import type { EntityError } from './errors';
import { clearRegistry } from './registry';

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const jobs = entity('uwrd_jobs', {
  columns: { id: uuid().primaryKey(), status: text({ max: 20 }), worker: text().nullable() },
});

type Job = typeof jobs.$row;

let updates = 0;

const store = () =>
  defineDriver({
    name: 'map',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = new Map<string, Row>();
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

beforeEach(() => {
  updates = 0;
});
afterAll(() => {
  clearRegistry();
});

describe('updateWhereReturning on a custom store', () => {
  test('a count-only store refuses before any update, including a multi-row match', async () => {
    const driver = store();
    expect(driver.repo(jobs).updateWhereReturning).toBeUndefined();
    const db = database({ jobs }, { driver });
    await db.jobs.insertAll([job(1), job(2)]);
    const refused = await caught(
      db.jobs.updateWhereReturning({ status: 'open' }, { status: 'taken' }),
    );
    expect(refused).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(String(refused?.cause)).toContain('Nothing was written');
    expect(updates).toBe(0);
    expect((await db.jobs.where({ status: 'open' }).all()).length).toBe(2);
  });
  test('count-only writes still work', async () => {
    const db = database({ jobs }, { driver: store() });
    await db.jobs.insertAll([job(1), job(2)]);
    expect(await db.jobs.updateWhere({ status: 'open' }, { worker: 'w' })).toBe(2);
  });
});
