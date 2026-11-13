// The absolute ceiling: a call over `STATEMENTS_MAX` is a finding whose fix lists its three busiest
// shapes; an entry's `statements: { max, why }` moves the ceiling for that primitive alone. Judged
// on the pass's own call, so a primitive flat at both sizes but 120 statements deep is still seen.

import { afterAll, describe, expect, test } from 'bun:test';
import { action, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { expectedQueryLoop } from '@ultimat3/db';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import {
  judgeStatementCeiling,
  STATEMENTS_MAX,
  statementCeilingFindings,
} from './exercise-statement-ceiling';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const tally = (fingerprint: string, count: number) => ({ fingerprint, count, unexpected: count });

describe(testName('unit', 'judgeStatementCeiling'), () => {
  test('the busiest call against 100: within at 100, over at 101 with its top three shapes', () => {
    expect(judgeStatementCeiling([{ statements: 100, shapes: [] }])).toEqual({
      verdict: 'within',
      statements: 100,
      max: STATEMENTS_MAX,
    });
    const over = judgeStatementCeiling([
      { statements: 3, shapes: [] },
      {
        statements: 101,
        shapes: [tally('a.findById', 1), tally('b.findById', 60), tally('c', 30), tally('d', 10)],
      },
    ]);
    expect(over).toEqual({
      verdict: 'over',
      statements: 101,
      max: 100,
      top: [
        { fingerprint: 'b.findById', count: 60 },
        { fingerprint: 'c', count: 30 },
        { fingerprint: 'd', count: 10 },
      ],
    });
  });

  test("a declared ceiling is the primitive's: 20 against a max of 10 is over, with its why", () => {
    const declared = { max: 10, why: 'a tight read' };
    expect(judgeStatementCeiling([{ statements: 20, shapes: [] }], declared)).toMatchObject({
      verdict: 'over',
      max: 10,
      why: 'a tight read',
    });
    expect(
      judgeStatementCeiling([{ statements: 150, shapes: [] }], { max: 150, why: 'x' }),
    ).toEqual({ verdict: 'within', statements: 150, max: 150, declared: true });
    // At the default figure too: the entry's written decision, which a floor never re-judges.
    expect(
      judgeStatementCeiling([{ statements: 90, shapes: [] }], { max: 100, why: 'bulk import' }),
    ).toEqual({ verdict: 'within', statements: 90, max: 100, declared: true });
    expect(judgeStatementCeiling([])).toBeUndefined();
  });

  test('statements an expectedQueryLoop declared are not judged: the loop argued for itself', () => {
    // A backfill's pass: 111 rows, each an update under its loop reason, each update's entity.row
    // read under its own, and one page read nobody declared. 223 sent, one judged.
    const loop = (fingerprint: string, count: number) => ({
      fingerprint,
      count,
      unexpected: 0,
      expected: 'a backfill writes every row it visits',
    });
    const pass = {
      statements: 223,
      shapes: [loop('r.findById', 111), loop('r.update', 111), tally('r.findMany', 1)],
    };
    expect(judgeStatementCeiling([pass])).toEqual({
      verdict: 'within',
      statements: 1,
      max: 100,
      expected: 222,
    });
    // Undeclared statements still count in full, and the busiest call is the busiest judged one.
    const mixed = {
      statements: 230,
      shapes: [loop('r.update', 120), tally('r.findById', 110)],
    };
    expect(judgeStatementCeiling([pass, mixed])).toEqual({
      verdict: 'over',
      statements: 110,
      max: 100,
      expected: 120,
      top: [{ fingerprint: 'r.findById', count: 110 }],
    });
  });

  test('one finding per primitive over its ceiling, its fix the rerun and the entry to raise', () => {
    const findings = statementCeilingFindings([
      {
        kind: 'query',
        name: 'feed',
        statementCeiling: { verdict: 'within', statements: 4, max: 100 },
      },
      {
        kind: 'action',
        name: 'importRows',
        statementCeiling: {
          verdict: 'over',
          statements: 140,
          max: 100,
          top: [{ fingerprint: 'rows.insert', count: 139 }],
        },
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_STATEMENTS_OVER_BUDGET');
    expect(findings[0]?.cause).toContain('140 statements in one call');
    expect(findings[0]?.cause).toContain('rows.insert ×139');
    expect(findings[0]?.fix).toStartWith(
      `defineExercise({ "importRows": { statements: { max: 140, why: '`,
    );
    expect(findings[0]?.fix).toEndWith('then: x exercise importRows --json');
    expect(findings[0]?.cause).not.toContain('expectedQueryLoop');
    // The excluded ones are named, so a count beside the record's own total reads as one.
    const [loop] = statementCeilingFindings([
      {
        kind: 'job',
        name: 'sweep',
        statementCeiling: { verdict: 'over', statements: 110, max: 100, expected: 120, top: [] },
      },
    ]);
    expect(loop?.cause).toContain('110 statements in one call (120 more under expectedQueryLoop');
  });
});

afterAll(() => {
  clearRegistry();
});

const items = entity('esc_items', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});
const driver = memoryDriver();
database({ items }, { driver });
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(items).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

/** 120 reads in one call, whatever the rows: flat at both sizes, and over the default ceiling. */
const deep = () =>
  action({
    input: t.object({ word: t.string.max(20) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the statement count is the subject here, not the policy'),
    handle: async () => {
      for (let i = 0; i < 120; i += 1) await driver.repo(items).findMany();
      return { ok: true };
    },
  });
registerActions({ escDeep: deep(), escDeclared: deep() });
registerActions({
  escLooped: action({
    input: t.object({ word: t.string.max(20) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the statement count is the subject here, not the policy'),
    handle: () =>
      expectedQueryLoop('reads the list once per form field', async () => {
        for (let i = 0; i < 120; i += 1) await driver.repo(items).findMany();
        return { ok: true };
      }),
  }),
});

const pass = async (only: string): Promise<ExerciseRecord> => {
  const records = await runExercisePass({
    entities: [items],
    writer,
    roles: () => [{ name: 'anonymous', actor: null }],
    only,
    overrides: defineExercise({
      escDeclared: { statements: { max: 120, why: 'reads the list once per form field' } },
    }),
  });
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass · statement ceiling'), () => {
  test('a call of 120 statements is over the default ceiling of 100', async () => {
    const record = await pass('escDeep');
    expect(record.outcome).toBe('reached');
    expect(record.statementCeiling).toMatchObject({ verdict: 'over', statements: 120, max: 100 });
    expect(statementCeilingFindings([record]).map((one) => one.code)).toEqual([
      'X_STATEMENTS_OVER_BUDGET',
    ]);
  });

  test("an entry's statements: { max: 120, why } holds the same call within", async () => {
    const record = await pass('escDeclared');
    expect(record.statementCeiling).toEqual({
      verdict: 'within',
      statements: 120,
      max: 120,
      declared: true,
    });
  });

  test('the same 120 under expectedQueryLoop are within the default: the loop is declared', async () => {
    const record = await pass('escLooped');
    expect(record.outcome).toBe('reached');
    expect(record.statements).toBe(120);
    expect(record.statementCeiling).toEqual({
      verdict: 'within',
      statements: 0,
      max: 100,
      expected: 120,
    });
    expect(statementCeilingFindings([record])).toEqual([]);
  });
});
