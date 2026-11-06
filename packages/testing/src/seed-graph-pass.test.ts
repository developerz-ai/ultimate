// The pass's one graph: a tenantless table seeded once however many primitives run, a fresh tenant
// pair per primitive pointing at those shared rows, the same rows for the same seed, and every
// write failure coded — a refused row names its factory, an environment failure keeps its own fix.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, UltimateError } from '@ultimat3/core';
import { entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { seedPass, TENANTS_PER_PRIMITIVE, tenantPair } from './seed-graph-pass';
import type { SeedRow, SeedWriter } from './seed-graph-plan';
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
    writer: { insert: async (row) => void rows.push(row), update: async () => undefined },
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
    };
    const failure = await failureOf(() => seedPass(entities, writer, { primitives: 1, seed: 1 }));
    expect(failure).toBe(missing);
  });
});
