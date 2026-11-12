// The declared optimistic lock on a `defineDriver` store: the shared cases memory and Postgres run,
// plus the race only a per-row store write can lose — a filtered write that meets a concurrent
// writer part way, which must still increment every row and never answer X_ENTITY_STALE.

import { afterAll, describe, expect, test } from 'bun:test';
import { selectRows } from './adapter';
import { database } from './database';
import { type DriverRepo, defineDriver } from './define-driver';
import type { EntityCore } from './entity';
import { clearRegistry } from './registry';
import { type LockedDb, lockedNotes, versionLockCases } from './version-lock-fixture';

afterAll(() => {
  clearRegistry();
});

type Hook = (rows: Map<string, Record<string, unknown>>) => void;

/** A Map store whose `update` runs `afterWrite` once the write landed: the concurrent writer. */
const mapStore = (afterWrite: { hook: Hook | undefined }) =>
  defineDriver({
    name: 'lock-map',
    capabilities: ['upsert'],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = new Map<string, Record<string, unknown>>();
      const keyOf = (row: Readonly<Record<string, unknown>>) =>
        JSON.stringify(table.$primaryKey.map((key) => row[key]));
      const all = () => rows.values() as Iterable<Row>;
      const matched = (plan: Parameters<DriverRepo<Row>['count']>[0]['plan']) =>
        selectRows(table, all(), { plan, after: undefined, limit: rows.size });
      return {
        select: async (read) => selectRows(table, all(), read),
        count: async ({ plan }) => matched(plan).length,
        insert: async (batch) => {
          for (const row of batch as readonly Record<string, unknown>[]) {
            rows.set(keyOf(row), { ...row });
          }
          return batch;
        },
        update: async ({ plan }, patch) => {
          const hit = matched(plan) as readonly Record<string, unknown>[];
          for (const row of hit) rows.set(keyOf(row), { ...row, ...patch });
          afterWrite.hook?.(rows);
          return hit.length;
        },
        // The lock admits only `onMatch: 'nothing'` (`set` empty): a stored row is kept as it is.
        upsert: async (batch) => {
          const fresh = batch.filter((row) => !rows.has(keyOf(row as Record<string, unknown>)));
          for (const row of fresh as readonly Record<string, unknown>[]) {
            rows.set(keyOf(row), { ...row });
          }
          return fresh;
        },
        delete: async ({ plan }) => {
          const hit = matched(plan) as readonly Record<string, unknown>[];
          for (const row of hit) rows.delete(keyOf(row));
          return hit.length;
        },
      };
    },
  });

describe('unit · defineDriver · version lock', () => {
  const concurrent: { hook: Hook | undefined } = { hook: undefined };
  const db: LockedDb = database({ notes: lockedNotes }, { driver: mapStore(concurrent) });
  versionLockCases(() => db, 2000);

  test('a filtered write racing a concurrent writer increments every row and never throws stale', async () => {
    const ids = [1, 2, 3].map(
      (n) => `00000000-0000-7000-8000-${String(3000 + n).padStart(12, '0')}`,
    );
    await db.notes.insertAll(ids.map((id) => ({ id, body: 'race' })));
    // After the FIRST per-row write lands, another process bumps row 2 — between the kit's read
    // and its write of that row.
    let fired = false;
    concurrent.hook = (rows) => {
      if (fired) return;
      fired = true;
      const key = JSON.stringify([ids[1]]);
      const row = rows.get(key);
      if (row !== undefined) rows.set(key, { ...row, lockVersion: Number(row['lockVersion']) + 1 });
    };
    try {
      expect(await db.notes.where({ body: 'race' }).updateAll({ body: 'swept' })).toBe(3);
    } finally {
      concurrent.hook = undefined;
    }
    expect(fired).toBe(true);
    const after = await Promise.all(ids.map((id) => db.notes.where({ id }).one()));
    expect(after.map((row) => [row?.body, row?.lockVersion])).toEqual([
      ['swept', 1],
      // 0 → 1 by the concurrent writer → 2 by this write: neither increment is lost.
      ['swept', 2],
      ['swept', 1],
    ]);
  });
});
