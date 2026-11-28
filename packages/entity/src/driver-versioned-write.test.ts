// A versioned entity's `updateMany` on a custom store: one compare-and-set per row on the version,
// and a refusal part way writes the moved rows back. The rollback must restore the row as the
// WINNING write compared against it. Through the kit every write moves the version, so a writer
// landing first is `X_ENTITY_STALE`; a writer sharing the store that does not (another program,
// a migration script) is the case left, and the store's `reading` hook is that writer.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { selectRows } from './adapter';
import { integer, text, uuid } from './columns';
import { type DriverRepo, defineDriver } from './define-driver';
import { entityUniqueViolation } from './driver-errors';
import { type EntityCore, entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const notes = entity('driver_versioned_write_notes', {
  columns: {
    id: uuid().primaryKey(),
    note: text({ max: 10 }).nullable(),
    lockVersion: integer().default(0),
  },
  version: 'lockVersion',
});

const FIRST = '00000000-0000-7000-8000-000000000001';
const SECOND = '00000000-0000-7000-8000-000000000002';
type Rows = Map<string, Record<string, unknown>>;

/**
 * A Map with `updateChecked`. Its second read — `FIRST`'s own, after the batch read both — runs
 * `reading` first; `SECOND`'s write refuses as a duplicate key would, after `FIRST` was written.
 */
const store = (reading: (rows: Rows) => void) => {
  const rows: Rows = new Map();
  let reads = 0;
  const driver = defineDriver({
    name: 'versioned-map',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const all = () => [...rows.values()] as Row[];
      const matched = (plan: Parameters<DriverRepo<Row>['count']>[0]['plan']): Row[] =>
        selectRows(table, all(), { plan, after: undefined, limit: rows.size });
      const set = (hit: readonly Row[], patch: Readonly<Record<string, unknown>>) => {
        for (const row of hit) {
          const id = String((row as Record<string, unknown>)['id']);
          if (id === SECOND && patch['note'] === 'mine') {
            throw entityUniqueViolation(table, `${table.$table}_note_key`);
          }
        }
        for (const row of hit) {
          const id = String((row as Record<string, unknown>)['id']);
          rows.set(id, { ...(row as object), ...patch });
        }
      };
      return {
        select: async (read) => {
          reads += 1;
          if (reads === 2) reading(rows);
          return selectRows(table, all(), read);
        },
        count: async ({ plan }) => matched(plan).length,
        insert: async (batch) => {
          for (const row of batch) {
            rows.set(String((row as Record<string, unknown>)['id']), { ...(row as object) });
          }
          return batch;
        },
        update: async ({ plan }, patch) => {
          const hit = matched(plan);
          set(hit, patch);
          return hit.length;
        },
        updateChecked: async ({ plan }, expected, patch) => {
          const hit = matched(plan);
          if (!Bun.deepEquals(hit, expected)) return false;
          set(hit, patch);
          return true;
        },
        delete: async () => 0,
      };
    },
  });
  return { driver, rows, armed: () => (reads = 0) };
};

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'resolved';
};

describe('versionedWrites reports the rows it won', () => {
  test('updateMany’s rollback restores the row its winning write compared against', async () => {
    // A writer that leaves the version alone: the kit's compare-and-set cannot see it.
    const { driver, rows, armed } = store((stored) => {
      const row = stored.get(FIRST);
      if (row !== undefined) stored.set(FIRST, { ...row, note: 'w' });
    });
    const repo = driver.repo(notes);
    await repo.insertAll([
      { id: FIRST, note: null, lockVersion: 0 },
      { id: SECOND, note: null, lockVersion: 0 },
    ]);
    armed();
    const code = await codeOf(async () =>
      repo.updateMany?.([
        { id: FIRST, patch: { note: 'mine', lockVersion: 0 } },
        { id: SECOND, patch: { note: 'mine', lockVersion: 0 } },
      ]),
    );
    expect(code).toBe('X_DB_UNIQUE_VIOLATION');
    expect(rows.get(FIRST)).toMatchObject({ note: 'w' });
  });

  test('a writer that moves the version first is X_ENTITY_STALE, and nothing is written', async () => {
    const { driver, rows, armed } = store((stored) => {
      const row = stored.get(FIRST);
      if (row !== undefined) stored.set(FIRST, { ...row, note: 'w', lockVersion: 1 });
    });
    const repo = driver.repo(notes);
    await repo.insertAll([
      { id: FIRST, note: null, lockVersion: 0 },
      { id: SECOND, note: null, lockVersion: 0 },
    ]);
    armed();
    const code = await codeOf(async () =>
      repo.updateMany?.([
        { id: FIRST, patch: { note: 'mine', lockVersion: 0 } },
        { id: SECOND, patch: { note: 'mine', lockVersion: 0 } },
      ]),
    );
    expect(code).toBe('X_ENTITY_STALE');
    expect(rows.get(FIRST)).toMatchObject({ note: 'w', lockVersion: 1 });
  });
});
