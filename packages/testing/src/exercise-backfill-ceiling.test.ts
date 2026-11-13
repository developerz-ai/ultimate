// A `backfill()` in the exercise pass: one call is the whole sweep, a write per seeded row under the
// factory's own `expectedQueryLoop`. The ceiling judges what no loop declared — the page reads — so
// the seed's size never decides the verdict. A row-per-row read the handle did NOT declare still does.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { backfill } from '@ultimat3/jobs';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import { STATEMENTS_MAX } from './exercise-statement-ceiling';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

afterAll(() => {
  clearRegistry();
});

const rows = entity('ebc_rows', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});
const driver = memoryDriver();
const db = database({ rows }, { driver });
const repo = driver.repo(rows);
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await repo.insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (seeded) => seeded.map(() => 'unchanged'),
};

/** More rows than the default ceiling: one pass over them is that many writes in one call. */
const SEEDED = STATEMENTS_MAX + 20;

backfill({
  tenant: 'none',
  name: 'ebc-sweep',
  source: () => db.rows,
  handle: async ({ rows: page }) => {
    for (const row of page) await db.rows.update(row.id, { title: row.title.trim() });
  },
});

const pass = async (): Promise<ExerciseRecord> => {
  for (let i = 0; i < SEEDED; i += 1) {
    await repo.insert({ id: crypto.randomUUID(), title: `row ${String(i)}` } as never);
  }
  const records = await runExercisePass({
    entities: [rows],
    writer,
    roles: () => [{ name: 'anonymous', actor: null }],
    only: 'ebc-sweep',
  });
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass · a backfill against the statement ceiling'), () => {
  test('a pass over more rows than the ceiling is within it: the per-row writes are declared', async () => {
    const record = await pass();
    expect(record.outcome).toBe('reached');
    expect(record.statements).toBeGreaterThan(STATEMENTS_MAX);
    expect(record.statementCeiling).toMatchObject({ verdict: 'within', max: STATEMENTS_MAX });
    const proof = record.statementCeiling;
    if (proof === undefined) return expect.unreachable('the pass observed the call');
    expect(proof.statements).toBeLessThan(STATEMENTS_MAX);
    expect((proof.expected ?? 0) + proof.statements).toBeGreaterThan(SEEDED);
  });
});
