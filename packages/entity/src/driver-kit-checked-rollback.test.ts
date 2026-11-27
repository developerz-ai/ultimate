// `updateMany` on a custom store is one store write per row, so a refusal part way writes the rows
// already moved BACK. Another writer may land on a moved row before the rollback reaches it: the
// store's `failing` hook is that writer, run inside the write that refuses — deterministic, no
// sleeps. A store with `updateChecked` restores only a row still holding what was written.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { selectRows } from './adapter';
import { text, uuid } from './columns';
import { type DriverDefinition, type DriverRepo, defineDriver } from './define-driver';
import { entityUniqueViolation } from './driver-errors';
import { type EntityCore, entity } from './entity';
import { anyOf } from './expr-connectives';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const cards = entity('driver_kit_rollback_cards', {
  columns: {
    id: uuid().primaryKey(),
    a: text({ max: 10 }).nullable(),
    b: text({ max: 10 }).nullable(),
    note: text({ max: 10 }).nullable(),
  },
  // Something to judge, so each row's write takes the checked path.
  invariants: (c) => [invariant('driver_kit_rollback_a_or_b', anyOf(c.a.isNull(), c.b.isNull()))],
});

const FIRST = '00000000-0000-7000-8000-000000000001';
const SECOND = '00000000-0000-7000-8000-000000000002';
type Rows = Map<string, Record<string, unknown>>;

/**
 * A Map per table. The write that touches `SECOND` runs `failing` (another writer, straight into
 * the store), then refuses as a duplicate key would — after `FIRST` was written.
 */
const toy = (checked: boolean, failing: (rows: Rows) => void) => {
  const rows: Rows = new Map();
  const definition: DriverDefinition = {
    name: checked ? 'rollback-checked' : 'rollback-plain',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const all = () => [...rows.values()] as Row[];
      const matched = (plan: Parameters<DriverRepo<Row>['count']>[0]['plan']): Row[] =>
        selectRows(table, all(), { plan, after: undefined, limit: rows.size });
      const set = (hit: readonly Row[], patch: Readonly<Record<string, unknown>>) => {
        for (const row of hit) {
          const id = String((row as Record<string, unknown>)['id']);
          if (id === SECOND && patch['note'] === 'mine') {
            failing(rows);
            throw entityUniqueViolation(table, `${table.$table}_note_key`);
          }
        }
        for (const row of hit) {
          const id = String((row as Record<string, unknown>)['id']);
          rows.set(id, { ...(row as object), ...patch });
        }
      };
      const repo: DriverRepo<Row> = {
        select: async (read) => selectRows(table, all(), read),
        count: async ({ plan }) => matched(plan).length,
        insert: async (batch) => {
          for (const row of batch) rows.set(String((row as Record<string, unknown>)['id']), row);
          return batch;
        },
        update: async ({ plan }, patch) => {
          const hit = matched(plan);
          set(hit, patch);
          return hit.length;
        },
        delete: async () => 0,
      };
      if (!checked) return repo;
      return {
        ...repo,
        updateChecked: async ({ plan }, expected, patch) => {
          const hit = matched(plan);
          if (!Bun.deepEquals(hit, expected)) return false;
          set(hit, patch);
          return true;
        },
      };
    },
  };
  return { definition, rows };
};

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'resolved';
};

/** Another writer moves `FIRST`'s note after this batch wrote it. */
const theirs = (rows: Rows) => {
  const row = rows.get(FIRST);
  if (row !== undefined) rows.set(FIRST, { ...row, note: 'theirs' });
};

const run = async (checked: boolean, failing: (rows: Rows) => void) => {
  const store = toy(checked, failing);
  const repo = defineDriver(store.definition).repo(cards);
  await repo.insertAll([
    { id: FIRST, a: null, b: null, note: null },
    { id: SECOND, a: null, b: null, note: null },
  ]);
  const code = await codeOf(() =>
    repo.updateMany([
      { id: FIRST, patch: { note: 'mine' } },
      { id: SECOND, patch: { note: 'mine' } },
    ]),
  );
  return { code, first: store.rows.get(FIRST), second: store.rows.get(SECOND) };
};

describe('updateMany’s rollback on a custom store', () => {
  test('with no updateChecked it restores unconditionally, over a newer write (today’s)', async () => {
    const { code, first } = await run(false, theirs);
    expect(code).toBe('X_DB_UNIQUE_VIOLATION');
    expect(first).toMatchObject({ note: null });
  });

  test('with updateChecked and no other writer, the moved row is restored', async () => {
    const { code, first, second } = await run(true, () => undefined);
    expect(code).toBe('X_DB_UNIQUE_VIOLATION');
    expect(first).toMatchObject({ note: null });
    expect(second).toMatchObject({ note: null });
  });

  test('with updateChecked, a newer write is kept and the refusal says the batch is torn', async () => {
    const { code, first } = await run(true, theirs);
    expect(code).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(first).toMatchObject({ note: 'theirs' });
  });
});
