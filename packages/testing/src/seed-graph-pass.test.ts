// The pass's one graph: a tenantless table seeded once however many primitives run, a fresh tenant
// pair per primitive pointing at those shared rows, the same rows for the same seed, and every
// write failure coded — a refused row names its factory, an environment failure keeps its own fix.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, UltimateError } from '@ultimat3/core';
import {
  type AnyColumn,
  entity,
  integer,
  invariant,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { defineFactory } from './factories';
import {
  deferredMayStayNull,
  seedPass,
  TENANTS_PER_PRIMITIVE,
  tenantPair,
} from './seed-graph-pass';
import type { SeedRow, SeedUpdate, SeedWriter } from './seed-graph-plan';
import { entitySeedWriter } from './seed-writer';
import { testName } from './test-types';

const plans = entity('sgp_plans', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});
const orgs = entity('sgp_orgs', {
  columns: { id: uuid().primaryKey(), planId: uuid().references(() => plans.id) },
});
const notes = entity('sgp_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 40 }),
  },
});
const entities = [plans, orgs, notes];

const collecting = (): { writer: SeedWriter; rows: SeedRow[] } => {
  const rows: SeedRow[] = [];
  return {
    rows,
    writer: {
      insert: async (row) => void rows.push(row),
      update: async () => undefined,
      snapshot: async (asked) => asked.map(() => null),
    },
  };
};

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the seed was written');
};

describe(testName('unit', 'seedPass'), () => {
  test('a row no partition holds is refused with the partitions() repair, not a factory', async () => {
    // Postgres' answer when the partitions were made around a migrate long past and never kept
    // ahead since: 23514 "no partition of relation … found for row" — no factory fixes that.
    const failure = await failureOf(() =>
      seedPass(
        entities,
        {
          insert: () =>
            Promise.reject(
              new UltimateError({
                code: 'X_DB_STATEMENT_FAILED',
                cause:
                  '[SQLSTATE 23514] PostgresError: no partition of relation "sgp_plans" found for row',
                fix: 'x doctor',
                meta: { sqlState: '23514' },
              }),
            ),
          update: async () => undefined,
          snapshot: async (asked) => asked.map(() => null),
        },
        { primitives: 1, seed: 3 },
      ),
    );
    const coded = isUltimateError(failure) ? [failure.code, failure.fix] : ['uncoded', ''];
    expect(coded[0]).toBe('X_SEED_GRAPH_UNSATISFIED');
    expect(coded[1]).toContain('partitions(');
  });

  test('a tenantless table is seeded once; every primitive owns a fresh tenant pair', async () => {
    const { writer, rows } = collecting();
    const graph = await seedPass(entities, writer, { primitives: 5, seed: 3 });
    expect(graph.tenants).toHaveLength(5 * TENANTS_PER_PRIMITIVE);
    expect(rows.filter((row) => row.entity === 'sgp_plans')).toHaveLength(3);
    const pairs = [0, 1, 2, 3, 4].map((index) => tenantPair(graph, index));
    expect(new Set(pairs.flat()).size).toBe(10);
    const planIds = new Set(rows.filter((r) => r.entity === 'sgp_plans').map((r) => r.row['id']));
    for (const org of rows.filter((row) => row.entity === 'sgp_orgs')) {
      expect(planIds.has(org.row['planId'])).toBe(true);
    }
  });

  test('one database takes the whole pass: no shared key is written twice', async () => {
    // The one seed writer, over a memory driver: a duplicate key is X_DB_UNIQUE_VIOLATION there.
    const writer = entitySeedWriter({ entities: { plans, orgs, notes }, driver: memoryDriver() });
    await seedPass(entities, writer, { primitives: 4, seed: 9 });
  });

  test('the same seed writes the same rows', async () => {
    const first = collecting();
    const second = collecting();
    await seedPass(entities, first.writer, { primitives: 2, seed: 5 });
    await seedPass(entities, second.writer, { primitives: 2, seed: 5 });
    expect(JSON.stringify(second.rows)).toBe(JSON.stringify(first.rows));
  });

  test('a row the database refuses is X_SEED_GRAPH_UNSATISFIED naming the entity', async () => {
    const writer: SeedWriter = {
      insert: (row) =>
        row.entity === 'sgp_orgs'
          ? Promise.reject(new TypeError('a trigger said no'))
          : Promise.resolve(),
      update: async () => undefined,
      snapshot: async (asked) => asked.map(() => null),
    };
    const failure = await failureOf(() => seedPass(entities, writer, { primitives: 1, seed: 1 }));
    expect(isUltimateError(failure) && failure.code).toBe('X_SEED_GRAPH_UNSATISFIED');
    expect(isUltimateError(failure) && failure.cause).toContain('sgp_orgs');
  });

  test('an environment failure keeps its own code and fix', async () => {
    const missing = new UltimateError({
      code: 'X_SEAL_KEY_MISSING',
      cause: 'no master key',
      fix: 'bunx x secrets init',
    });
    const writer: SeedWriter = {
      insert: () => Promise.reject(missing),
      update: async () => undefined,
      snapshot: async (asked) => asked.map(() => null),
    };
    const failure = await failureOf(() => seedPass(entities, writer, { primitives: 1, seed: 1 }));
    expect(failure).toBe(missing);
  });

  test('a cross-column invariant no generated row meets is satisfied by an app factory', async () => {
    // A label that spells its own size: no generated pair of a text and an integer meets it.
    const spelled = (label: string, size: number): boolean => label === `size-${size}`;
    const labelled = entity('sgp_labelled', {
      columns: { id: uuid().primaryKey(), label: text({ max: 40 }), size: integer() },
      invariants: (c) => [
        invariant('sgp_label_spells_size', c.satisfies(spelled, ['label', 'size'])),
      ],
    });
    // The app's write path runs the JS rule (`$assert`); a refusal there is the pass's red.
    const rows: SeedRow[] = [];
    const labelledWriter = (): SeedWriter => ({
      insert: async (row) => {
        labelled.$assert(labelled.$parse(row.row));
        rows.push(row);
      },
      update: async () => undefined,
      snapshot: async (asked) => asked.map(() => null),
    });
    const bare = await failureOf(() =>
      seedPass([labelled], labelledWriter(), { primitives: 1, seed: 2 }),
    );
    expect(isUltimateError(bare) && bare.code).toBe('X_SEED_GRAPH_UNSATISFIED');
    expect(isUltimateError(bare) && bare.fix).toContain('defineExercise({}, { factories:');

    const factory = defineFactory<{ label: string; size: number }>(labelled, {
      defaults: (index) => ({ label: `size-${index}`, size: index }),
    });
    const writer = labelledWriter();
    await seedPass([labelled], writer, {
      primitives: 1,
      seed: 2,
      factories: { sgp_labelled: factory },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) expect(row['label']).toBe(`size-${row['size']}`);
  });

  test('a factory keyed by a name no seeded entity has is refused, naming what is seeded', async () => {
    const factory = defineFactory<{ title: string }>(plans, { defaults: () => ({ title: 'x' }) });
    const failure = await failureOf(() =>
      seedPass(entities, collecting().writer, {
        primitives: 1,
        seed: 1,
        factories: { sgp_plan: factory },
      }),
    );
    expect(isUltimateError(failure) && failure.code).toBe('X_DECLARATION_UNKNOWN');
    expect(isUltimateError(failure) && failure.cause).toContain('sgp_plans');
  });

  // `sgp_a_teams` sorts first, so the cycle breaks at its nullable captain — and the app's own
  // trigger (no declaration says so) refuses every UPDATE of it.
  const teams = entity('sgp_a_teams', {
    columns: {
      id: uuid().primaryKey(),
      captainId: uuid()
        .references((): AnyColumn => players.id)
        .nullable(),
    },
  });
  const players = entity('sgp_b_players', {
    columns: { id: uuid().primaryKey(), teamId: uuid().references((): AnyColumn => teams.id) },
  });
  const updateRefusing = (refusal: unknown): { writer: SeedWriter; tried: SeedUpdate[] } => {
    const tried: SeedUpdate[] = [];
    return {
      tried,
      writer: {
        insert: async () => undefined,
        update: (update) => {
          tried.push(update);
          return Promise.reject(refusal);
        },
        snapshot: async (asked) => asked.map(() => null),
      },
    };
  };
  const triggerSaidNo = new UltimateError({
    code: 'X_DB_STATEMENT_FAILED',
    cause: 'sgp_a_teams rows are never updated',
    fix: 'see the trigger',
  });

  test('a deferred key the database refuses to set stays null: the pass goes on', async () => {
    const { writer, tried } = updateRefusing(triggerSaidNo);
    const graph = await seedPass([teams, players], writer, { primitives: 1, seed: 4 });
    expect(tried.length).toBeGreaterThan(0);
    // The graph says what was written: no update the database refused.
    expect(graph.updates).toEqual([]);
    for (const insert of graph.inserts.filter((row) => row.entity === 'sgp_a_teams')) {
      expect(insert.row['captainId']).toBeNull();
    }
  });

  test('an environment failure on a deferred update keeps its own code', async () => {
    const down = new UltimateError({
      code: 'X_DB_UNAVAILABLE',
      cause: 'down',
      fix: 'x doctor --json',
    });
    const failure = await failureOf(() =>
      seedPass([teams, players], updateRefusing(down).writer, { primitives: 1, seed: 4 }),
    );
    expect(failure).toBe(down);
  });

  test('deferredMayStayNull leaves an insert refusal to its caller', async () => {
    const writer = deferredMayStayNull({
      ...updateRefusing(triggerSaidNo).writer,
      insert: () => Promise.reject(triggerSaidNo),
    });
    await writer.update({ entity: 'sgp_a_teams', tenant: null, key: { id: 1 }, patch: {} });
    expect(
      await failureOf(() => writer.insert({ entity: 'x', table: 'x', tenant: null, row: {} })),
    ).toBe(triggerSaidNo);
  });
});
