// A judged update on a custom store reads the rows, judges them, then writes. Another writer may
// land between the judge and the write: the store's `between` hook is that writer, run at the one
// instant it matters, so the race is deterministic — no sleeps, no timing. A store with
// `updateChecked` loses the compare-and-set and the kit re-judges; one without keeps today's write
// and says so once, when its first judged table opens.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { InstrumentEventMap } from '@ultimat3/core';
import { isUltimateError, resetInstrumentation, subscribe } from '@ultimat3/core';
import { selectRows } from './adapter';
import { text, uuid } from './columns';
import { type DriverDefinition, type DriverRepo, defineDriver } from './define-driver';
import { MAX_CHECKED_RETRIES } from './driver-kit-checked-update';
import { UNCHECKED_UPDATES } from './driver-kit-unchecked-warning';
import { type EntityCore, entity } from './entity';
import { anyOf } from './expr-connectives';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

afterEach(() => resetInstrumentation());
afterAll(() => {
  clearRegistry();
});

const slots = entity('driver_kit_checked_slots', {
  columns: {
    id: uuid().primaryKey(),
    status: text({ max: 10 }),
    a: text({ max: 10 }).nullable(),
    b: text({ max: 10 }).nullable(),
    note: text({ max: 10 }).nullable(),
  },
  // At most one of the two is set: a concurrent `b` makes a judged `a` wrong.
  invariants: (c) => [invariant('driver_kit_checked_a_or_b', anyOf(c.a.isNull(), c.b.isNull()))],
});
type Slot = typeof slots.$row;

const plain = entity('driver_kit_checked_plain', {
  columns: { id: uuid().primaryKey(), status: text({ max: 10 }) },
});

const ID = '00000000-0000-7000-8000-000000000007';
const SEED: Slot = { id: ID, status: 'draft', a: null, b: null, note: null };

/** What another process writes, straight into the store, between the kit's judge and its write. */
type Between = (rows: Map<string, Record<string, unknown>>) => void;

interface Toy {
  readonly definition: DriverDefinition;
  readonly stored: () => Record<string, unknown> | undefined;
  readonly attempts: () => number;
}

/**
 * A Map per table. `between` runs once, inside the write, before the store applies it — exactly
 * where a concurrent writer lands. `checked: true` adds an atomic `updateChecked`; `losing: true`
 * makes it lose every time, as a store whose rows never settle would.
 */
const toy = (options: { checked: boolean; between?: Between; losing?: boolean }): Toy => {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  let between = options.between;
  let attempts = 0;
  const race = (rows: Map<string, Record<string, unknown>>) => {
    const once = between;
    between = undefined;
    once?.(rows);
  };
  const definition: DriverDefinition = {
    name: options.checked ? 'toy-checked' : 'toy-plain',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = tables.get(table.$name) ?? new Map<string, Record<string, unknown>>();
      tables.set(table.$name, rows);
      const all = () => [...rows.values()] as Row[];
      const matched = (plan: Parameters<DriverRepo<Row>['count']>[0]['plan']): Row[] =>
        selectRows(table, all(), { plan, after: undefined, limit: rows.size });
      const keyOf = (row: Row) => String((row as Record<string, unknown>)['id']);
      const apply = (hit: readonly Row[], patch: Readonly<Record<string, unknown>>) => {
        for (const row of hit) rows.set(keyOf(row), { ...(row as object), ...patch });
      };
      const repo: DriverRepo<Row> = {
        select: async (read) => selectRows(table, all(), read),
        count: async ({ plan }) => matched(plan).length,
        insert: async (batch) => {
          for (const row of batch) rows.set(keyOf(row), { ...(row as object) });
          return batch;
        },
        update: async ({ plan }, patch) => {
          race(rows);
          const hit = matched(plan);
          apply(hit, patch);
          return hit.length;
        },
        delete: async ({ plan }) => {
          const hit = matched(plan);
          for (const row of hit) rows.delete(keyOf(row));
          return hit.length;
        },
      };
      if (!options.checked) return repo;
      return {
        ...repo,
        // No await between the comparison and the set: atomic, as one JS turn is.
        updateChecked: async ({ plan }, expected, patch) => {
          attempts += 1;
          race(rows);
          const hit = matched(plan);
          if (options.losing === true || !Bun.deepEquals(hit, expected)) return false;
          apply(hit, patch);
          return true;
        },
      };
    },
  };
  return {
    definition,
    stored: () => tables.get(slots.$name)?.get(ID),
    attempts: () => attempts,
  };
};

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'resolved';
};

/** Another writer sets `b` on row 7 — legal alone, illegal beside the `a` being judged. */
const setsB: Between = (rows) => {
  const row = rows.get(ID);
  if (row !== undefined) rows.set(ID, { ...row, b: 'theirs' });
};

const seeded = async (store: Toy) => {
  const repo = defineDriver(store.definition).repo(slots);
  await repo.insert(SEED);
  return repo;
};

describe('a judged filtered update on a custom store, raced between the judge and the write', () => {
  test('a store with no updateChecked writes a row the invariant refuses (the race, kept)', async () => {
    const store = toy({ checked: false, between: setsB });
    const repo = await seeded(store);
    expect(await repo.updateWhere({ status: 'draft' }, { a: 'mine' })).toBe(1);
    // Documented: without updateChecked the store holds both — the defect #1379 names.
    expect(store.stored()).toMatchObject({ a: 'mine', b: 'theirs' });
  });

  test('a store with updateChecked loses the set, and the kit re-judges the newer row', async () => {
    const store = toy({ checked: true, between: setsB });
    const repo = await seeded(store);
    expect(await codeOf(() => repo.updateWhere({ status: 'draft' }, { a: 'mine' }))).toBe(
      'X_INVARIANT_VIOLATED',
    );
    expect(store.stored()).toMatchObject({ a: null, b: 'theirs' });
    expect(store.attempts()).toBe(1);
  });

  test('a lost set over a change the patch survives is retried and written', async () => {
    const store = toy({
      checked: true,
      between: (rows) => {
        const row = rows.get(ID);
        if (row !== undefined) rows.set(ID, { ...row, note: 'theirs' });
      },
    });
    const repo = await seeded(store);
    expect(await repo.updateWhere({ status: 'draft' }, { a: 'mine' })).toBe(1);
    expect(store.stored()).toMatchObject({ a: 'mine', note: 'theirs' });
    expect(store.attempts()).toBe(2);
  });

  test('a row that left the filter in the race is not written', async () => {
    const store = toy({
      checked: true,
      between: (rows) => {
        const row = rows.get(ID);
        if (row !== undefined) rows.set(ID, { ...row, status: 'published' });
      },
    });
    const repo = await seeded(store);
    expect(await repo.updateWhere({ status: 'draft' }, { a: 'mine' })).toBe(0);
    expect(store.stored()).toMatchObject({ status: 'published', a: null });
  });

  test('update(id) takes the same checked path', async () => {
    const store = toy({ checked: true, between: setsB });
    const repo = await seeded(store);
    expect(await codeOf(() => repo.update(ID, { a: 'mine' }))).toBe('X_INVARIANT_VIOLATED');
    expect(store.stored()).toMatchObject({ a: null, b: 'theirs' });
  });

  test('a set that never lands is a retryable serialization failure, after a bounded retry', async () => {
    const store = toy({ checked: true, losing: true });
    const repo = await seeded(store);
    expect(await codeOf(() => repo.updateWhere({ status: 'draft' }, { a: 'mine' }))).toBe(
      'X_DB_SERIALIZATION_FAILURE',
    );
    expect(store.stored()).toMatchObject({ a: null });
    expect(store.attempts()).toBe(MAX_CHECKED_RETRIES + 1);
  });
});

type LogRecordEvent = InstrumentEventMap['log.record'];
const heard = (): LogRecordEvent[] => {
  const seen: LogRecordEvent[] = [];
  subscribe('log.record', ({ payload }) => {
    if (payload.message === UNCHECKED_UPDATES) seen.push(payload);
  });
  return seen;
};

describe('a store with no updateChecked says so, once per driver', () => {
  test('the first judged table warns, naming the driver, the entity and the method', () => {
    const seen = heard();
    const driver = defineDriver(toy({ checked: false }).definition);
    driver.repo(slots);
    driver.repo(slots);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.level).toBe('warn');
    expect(seen[0]?.fields).toMatchObject({
      code: 'X_DRIVER_UNSUPPORTED',
      capability: 'updateChecked',
      driver: 'toy-plain',
      entity: slots.$name,
    });
    expect(String(seen[0]?.fields['fix'])).toContain('updateChecked');
  });

  test('a table with nothing to judge does not warn; a store with updateChecked never does', () => {
    const seen = heard();
    defineDriver(toy({ checked: false }).definition).repo(plain);
    defineDriver(toy({ checked: true }).definition).repo(slots);
    expect(seen).toHaveLength(0);
  });
});
