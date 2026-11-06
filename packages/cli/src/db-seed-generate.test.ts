// `x db seed --generate`'s rules with no database: which environments may take generated rows,
// what the flags parse to, and that one pass is one row in the same report `x db seed` prints —
// a writer that throws is a failed row with its finding, never a green run.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, UltimateError } from '@ultimat3/core';
import { boolean, entity, text, uuid } from '@ultimat3/entity';
import type { SeedRow, SeedWriter } from '@ultimat3/testing';
import { dbSpec } from './cmd-db-spec';
import {
  GENERATED_SEED,
  generatedSeedFlags,
  generatedSeedPlan,
  refuseGeneratedSeed,
  writeGeneratedSeed,
} from './db-seed-generate';
import { parseArgs } from './parse';

const orgs = entity('dsg_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const notes = entity('dsg_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    body: text({ max: 80 }),
    done: boolean(),
  },
});
const schema = { orgs, notes };

const refusal = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'no refusal';
};

const transaction = <T>(work: () => Promise<T>): Promise<T> => work();

describe('unit · x db seed --generate', () => {
  test('development and test take generated rows; production is refused even with --tier dev', () => {
    expect(refusal(() => refuseGeneratedSeed('development', undefined))).toBe('no refusal');
    expect(refusal(() => refuseGeneratedSeed('test', 'dev'))).toBe('no refusal');
    expect(refusal(() => refuseGeneratedSeed('production', undefined))).toBe('X_SEED_ENVIRONMENT');
    expect(refusal(() => refuseGeneratedSeed('production', 'dev'))).toBe('X_SEED_ENVIRONMENT');
    expect(refusal(() => refuseGeneratedSeed('development', 'reference'))).toBe(
      'X_SEED_ENVIRONMENT',
    );
  });

  test('--rows and --seed are integers or X_CLI_BAD_FLAG', () => {
    const args = parseArgs(['db', 'seed', '--generate', '--rows', '5', '--seed', '42'], [dbSpec]);
    expect(generatedSeedFlags(args)).toEqual({ rows: 5, seed: 42 });
    expect(generatedSeedFlags(parseArgs(['db', 'seed', '--generate'], [dbSpec]))).toEqual({});
    const bad = parseArgs(['db', 'seed', '--generate', '--rows', '0'], [dbSpec]);
    expect(refusal(() => generatedSeedFlags(bad))).toBe('X_CLI_BAD_FLAG');
  });

  test('the same seed plans the same bytes; --rows sizes every table', () => {
    const one = generatedSeedPlan(schema, { rows: 2, seed: 7 });
    expect(JSON.stringify(generatedSeedPlan(schema, { rows: 2, seed: 7 }))).toBe(
      JSON.stringify(one),
    );
    expect(one.inserts.filter((row) => row.entity === 'dsg_notes')).toHaveLength(
      2 * one.tenants.length,
    );
  });

  test('a pass is one row of the x db seed report, every insert counted', async () => {
    const graph = generatedSeedPlan(schema, { rows: 2, seed: 7 });
    const written: SeedRow[] = [];
    const writer: SeedWriter = {
      insert: async (row) => {
        written.push(row);
      },
      update: async () => {},
    };
    const row = await writeGeneratedSeed({ graph, writer, transaction, dryRun: false });
    expect(row).toMatchObject({ name: GENERATED_SEED, tier: 'dev', status: 'ok', finding: null });
    expect(row.inserted).toBe(graph.inserts.length);
    expect(written).toHaveLength(graph.inserts.length);
  });

  test('--dry-run counts the plan and writes nothing', async () => {
    const graph = generatedSeedPlan(schema, { rows: 1, seed: 7 });
    let calls = 0;
    const writer: SeedWriter = {
      insert: async () => {
        calls += 1;
      },
      update: async () => {},
    };
    const row = await writeGeneratedSeed({ graph, writer, transaction, dryRun: true });
    expect(calls).toBe(0);
    expect(row.inserted).toBe(graph.inserts.length);
  });

  test('a writer that throws is a failed row with its finding, never ok', async () => {
    const graph = generatedSeedPlan(schema, { rows: 1, seed: 7 });
    const writer: SeedWriter = {
      insert: async () => {
        // The writer is input here: a coded refusal like the one a missing table becomes.
        throw new UltimateError({
          code: 'X_DB_UNAVAILABLE',
          cause: 'relation "dsg_orgs" does not exist',
          fix: 'x db migrate --json',
        });
      },
      update: async () => {},
    };
    const row = await writeGeneratedSeed({ graph, writer, transaction, dryRun: false });
    expect(row.status).toBe('failed');
    expect(row.inserted).toBe(0);
    expect(row.finding?.cause).toContain('dsg_orgs');
  });
});
