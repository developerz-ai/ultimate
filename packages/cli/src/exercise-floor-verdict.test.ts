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

describe('unit · measuredStatementsMax', () => {
  test('the busiest undeclared call, never under the default 100', () => {
    expect(measuredStatementsMax([heavy(13)])).toBe(100);
    expect(measuredStatementsMax([heavy(13), heavy(140), heavy(300, 'declared')])).toBe(140);
  });
});
