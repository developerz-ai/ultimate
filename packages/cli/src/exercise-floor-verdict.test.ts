// The combined floor verdict: a seed failure and a statement ceiling are warnings until the app's
// `x.verify.json` opts in, red after — and a seed failure is red exactly when its unproven ratio is.

import { describe, expect, test } from 'bun:test';
import type { FloorRecord } from './exercise-floor-verdict';
import { exerciseFloorVerdict, measuredStatementsMax } from './exercise-floor-verdict';

const SEED_FAILED: FloorRecord = {
  kind: 'query',
  name: 'feed',
  outcome: 'reached',
  scale: {
    verdict: 'unproven',
    reason: 'the sized seed failed',
    seed: {
      entity: 'posts',
      table: 'posts',
      cause: 'duplicate key value violates unique constraint "posts_slug"',
    },
  },
} as FloorRecord;

const heavy = (statements: number, why?: string): FloorRecord =>
  ({
    kind: 'query',
    name: `q${String(statements)}`,
    outcome: 'reached',
    statementCeiling:
      statements > 100 || why !== undefined
        ? {
            verdict: 'over',
            statements,
            max: 100,
            top: [{ fingerprint: 'posts.findById', count: statements }],
            ...(why === undefined ? {} : { why }),
          }
        : { verdict: 'within', statements, max: 100 },
  }) as FloorRecord;

const codes = (verdict: { readonly findings: readonly { readonly code: string }[] }) =>
  verdict.findings.map((one) => one.code);

describe('unit · exerciseFloorVerdict', () => {
  test('no exercise key: the seed failure and the ceiling are warnings, nothing is red', () => {
    const verdict = exerciseFloorVerdict([SEED_FAILED, heavy(140)], undefined);
    expect(verdict.findings).toEqual([]);
    expect(verdict.warnings.some((line) => line.startsWith('X_EXERCISE_SEED_FAILED'))).toBe(true);
    expect(verdict.warnings.some((line) => line.startsWith('X_STATEMENTS_OVER_BUDGET'))).toBe(true);
  });

  test('unprovenMax 0: the seed failure is red beside the ratio it explains, naming the entity', () => {
    const verdict = exerciseFloorVerdict([SEED_FAILED], { unprovenMax: 0 });
    expect(codes(verdict)).toEqual(['X_EXERCISE_UNPROVEN_ABOVE_FLOOR', 'X_EXERCISE_SEED_FAILED']);
    expect(verdict.findings[1]?.cause).toContain('posts');
  });

  test('statementsMax: 20 statements against a max of 10 is red; within it is not', () => {
    expect(codes(exerciseFloorVerdict([heavy(20)], { statementsMax: 10 }))).toEqual([
      'X_STATEMENTS_OVER_BUDGET',
    ]);
    expect(exerciseFloorVerdict([heavy(140)], { statementsMax: 200 }).findings).toEqual([]);
  });

  test('an entry that declared its own ceiling with a why keeps it', () => {
    const declared = heavy(140, 'imports one row per line');
    expect(codes(exerciseFloorVerdict([declared], { statementsMax: 500 }))).toEqual([
      'X_STATEMENTS_OVER_BUDGET',
    ]);
  });
});

// `statements: { max: 100, why }` equals the default figure, and was read as undeclared: a floor's
// lower `statementsMax` re-judged it red, against the entry's own written decision.
const declaredAtDefault: FloorRecord = {
  kind: 'query',
  name: 'bulk',
  outcome: 'reached',
  statementCeiling: { verdict: 'within', statements: 90, max: 100, declared: true },
} as FloorRecord;

describe('unit · a declared ceiling at the default figure', () => {
  test('stands against a lower statementsMax', () => {
    expect(exerciseFloorVerdict([declaredAtDefault], { statementsMax: 10 }).findings).toEqual([]);
  });

  test('is no undeclared call for the measured figure', () => {
    const busy: FloorRecord = {
      ...declaredAtDefault,
      statementCeiling: { verdict: 'within', statements: 100, max: 100, declared: true },
    } as FloorRecord;
    expect(measuredStatementsMax([busy, heavy(13)])).toBe(100);
    expect(exerciseFloorVerdict([busy, heavy(13)], { statementsMax: 13 }).findings).toEqual([]);
  });
});

describe('unit · measuredStatementsMax', () => {
  test('the busiest undeclared call, never under the default 100', () => {
    expect(measuredStatementsMax([heavy(13)])).toBe(100);
    expect(measuredStatementsMax([heavy(13), heavy(140), heavy(300, 'declared')])).toBe(140);
  });
});

// A backfill's pass under a strict floor: 222 statements under its loop reasons, five it did not declare.
const sweep: FloorRecord = {
  kind: 'job',
  name: 'smoke-backfill',
  outcome: 'reached',
  statementCeiling: { verdict: 'within', statements: 5, max: 100, expected: 222 },
} as FloorRecord;

describe('unit · statements an expectedQueryLoop declared, under a floor', () => {
  test('a strict statementsMax re-judges the judged count, the excluded count carried', () => {
    expect(exerciseFloorVerdict([sweep], { statementsMax: 100 }).findings).toEqual([]);
    const [red] = exerciseFloorVerdict([sweep], { statementsMax: 4 }).findings;
    expect(red?.cause).toContain('5 statements in one call (222 more under expectedQueryLoop');
    expect(measuredStatementsMax([sweep])).toBe(100);
  });
});
