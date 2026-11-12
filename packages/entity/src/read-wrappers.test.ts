// The read members sweep 5b added — `latestBy`, filtered `countBy`, `aggregates` and `lockKeys` —
// through every seam a repository passes: sealing, search resolution, the memory statement report
// and a `defineDriver` store, which composes them from the capabilities it already declares.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError, resetInstrumentation, subscribe } from '@ultimat3/core';
import { selectRows } from './adapter';
import { integer, text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { type DriverRepo, defineDriver } from './define-driver';
import type { EntityCore } from './entity';
import { entity } from './entity';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { sealedRepo } from './sealed-repo';

afterEach(() => {
  resetInstrumentation();
  clearRegistry();
});

const idAt = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
  return 'resolved';
};

const messagesEntity = () =>
  entity('rw_messages', {
    columns: {
      id: uuid().primaryKey(),
      thread: text(),
      seq: integer(),
      body: text(),
    },
  });

const seed = (thread: string, seqs: readonly number[], from: number) =>
  seqs.map((seq, at) => ({ id: idAt(from + at), thread, seq, body: `${thread}${seq}` }));

/** A store with a Map per table and nothing past what the kit requires, plus `countBy`/`lock`. */
const mapStore = (capabilities: Parameters<typeof defineDriver>[0]['capabilities']) =>
  defineDriver({
    name: 'rw-map',
    capabilities,
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = new Map<string, Row>();
      const keyOf = (row: Row) =>
        JSON.stringify(table.$primaryKey.map((key) => (row as Record<string, unknown>)[key]));
      const matched = (plan: Parameters<DriverRepo<Row>['count']>[0]['plan']) =>
        selectRows(table, rows.values(), { plan, after: undefined, limit: rows.size });
      const held: string[] = [];
      return {
        select: async (read) => selectRows(table, rows.values(), read),
        count: async ({ plan }) => matched(plan).length,
        insert: async (batch) => {
          for (const row of batch) rows.set(keyOf(row), row);
          return batch;
        },
        update: async ({ plan }, patch) => {
          const hit = matched(plan);
          for (const row of hit) rows.set(keyOf(row), { ...row, ...patch } as Row);
          return hit.length;
        },
        delete: async ({ plan }) => {
          const hit = matched(plan);
          for (const row of hit) rows.delete(keyOf(row));
          return hit.length;
        },
        countBy: async (column, { plan }) => {
          const counts = new Map<unknown, number>();
          for (const row of matched(plan)) {
            const value = (row as Record<string, unknown>)[column];
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return [...counts];
        },
        lock: async (_filter, fn) => fn(null, { id: 'tx', onRollback: () => undefined }),
        lockKey: async (key, fn, tx) => {
          held.push(key);
          return fn(tx ?? { id: `tx:${key}`, onRollback: () => undefined });
        },
        // Exposed so a test can read the order the kit took the keys in.
        approximateCount: async () => held.length,
      } as DriverRepo<Row>;
    },
  });

describe('a defineDriver store composes the new reads from what it declares', () => {
  test('a filtered countBy answers 0 for a group the filter empties, never absent', async () => {
    const messages = messagesEntity();
    const db = database({ messages }, { driver: mapStore(['aggregate:countBy']) });
    await db.messages.insertAll([...seed('a', [1, 2, 3], 1), ...seed('b', [1], 10)]);
    const counts = await db.messages.countBy('thread', { where: [['seq', 'gte', 2]] });
    // In the map's own order — biggest filtered group first — never sorted here, which hid it.
    expect([...counts]).toEqual([
      ['a', 2],
      ['b', 0],
    ]);
  });

  test('a filtered countBy orders groups by the FILTERED count, not the unfiltered one', async () => {
    const messages = messagesEntity();
    const db = database({ messages }, { driver: mapStore(['aggregate:countBy']) });
    await db.messages.insertAll([...seed('a', [1, 1, 1], 1), ...seed('b', [5], 10)]);
    const counts = await db.messages.countBy('thread', { where: [['seq', 'gte', 2]] });
    expect([...counts]).toEqual([
      ['b', 1],
      ['a', 0],
    ]);
  });

  test('aggregate({ … }) runs each measure under its own capability, filter included', async () => {
    const messages = messagesEntity();
    const db = database({ messages }, { driver: mapStore(['aggregate:countBy']) });
    await db.messages.insertAll(seed('a', [1, 2, 3], 1));
    expect(
      await db.messages.aggregate({
        all: { fn: 'count' },
        late: { fn: 'count', where: [['seq', 'gte', 2]] },
      }),
    ).toEqual({ all: 3, late: 2 });
    // `max` needs `aggregate:max`, which this store did not declare: refused by name.
    expect(await codeOf(() => db.messages.aggregate({ top: { fn: 'max', column: 'seq' } }))).toBe(
      'X_DRIVER_UNSUPPORTED',
    );
  });

  test('latestBy without a store method folds paged reads: one row per group', async () => {
    const messages = messagesEntity();
    const db = database({ messages }, { driver: mapStore([]) });
    await db.messages.insertAll([...seed('a', [1, 3, 2], 1), ...seed('b', [7], 10)]);
    const latest = await db.messages.latestBy('thread', { order: 'seq' });
    expect(latest.map((row) => [row.thread, row.seq])).toEqual([
      ['a', 3],
      ['b', 7],
    ]);
  });

  test('lockKeys takes the store`s one-key lock per key, sorted, deduped', async () => {
    const messages = messagesEntity();
    const driver = mapStore(['lock', 'aggregate:approximateCount']);
    const db = database({ messages }, { driver });
    const seen: string[] = [];
    await db.messages.lockKeys(['b', 'a', 'b'], async () => {
      seen.push('inside');
    });
    expect(seen).toEqual(['inside']);
    expect(await db.messages.approximateCount()).toBe(2);
  });
});

describe('the sealing seam on the new reads', () => {
  const vault = entity('rw_vault', {
    columns: { id: uuid().primaryKey(), label: text(), secret: text().sealed() },
  });

  /** Records the arguments that reached it; answers nothing interesting. */
  const recording = () => {
    const seen: unknown[] = [];
    const repo = {
      countBy: async (_column: string, _args: unknown, options: unknown) => {
        seen.push(options);
        return new Map();
      },
      aggregates: async (measures: unknown) => {
        seen.push(measures);
        return {};
      },
      latestBy: async () => [],
    } as unknown as Repo<Record<string, unknown>>;
    return { repo, seen };
  };

  test('a sealed column in a measure, its filter, a grouped filter or a latestBy order is refused', async () => {
    const { repo, seen } = recording();
    const sealing = sealedRepo(vault, repo);
    const where = [{ column: 'secret', op: 'eq' as const, value: 'x' }];
    expect(await codeOf(() => sealing.countBy('label', {}, { where }))).toBe(
      'X_ENTITY_SEALED_PREDICATE',
    );
    expect(await codeOf(async () => sealing.aggregates?.({ n: { fn: 'count', where } }))).toBe(
      'X_ENTITY_SEALED_PREDICATE',
    );
    expect(
      await codeOf(async () =>
        sealing.latestBy?.({
          group: 'label',
          order: [{ column: 'secret', direction: 'desc' }],
          perGroup: 1,
        }),
      ),
    ).toBe('X_ENTITY_SEALED_PREDICATE');
    // A filter on a plain column passes through, its options intact.
    const plain = [{ column: 'label', op: 'eq' as const, value: 'l' }];
    await sealing.countBy('label', {}, { where: plain });
    expect(seen).toEqual([{ where: plain }]);
  });
});

describe('the memory statement report', () => {
  test('latestBy and aggregate({ … }) are each one reported statement', async () => {
    const messages = messagesEntity();
    const db = database({ messages }, { driver: memoryDriver() });
    await db.messages.insertAll(seed('a', [1, 2], 1));
    const ops: string[] = [];
    subscribe('db.statement', (event) => void ops.push(String(event.payload.attribution?.op)));
    await db.messages.latestBy('thread', { order: 'seq' });
    await db.messages.aggregate({ n: { fn: 'count' } });
    expect(ops).toEqual(['latestBy', 'aggregates']);
  });
});
