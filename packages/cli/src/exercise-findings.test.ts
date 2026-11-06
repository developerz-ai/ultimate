// What `x exercise` makes of a pass's records: `unreached` is a finding whose fix is the override to
// paste, every other outcome is not, and the report is the same document `--json` and
// `.x/exercise.json` carry.

import { describe, expect, test } from 'bun:test';
import type { ExerciseRecord } from '@ultimat3/testing';
import {
  exerciseCounts,
  exerciseFindings,
  exerciseReport,
  renderExerciseTable,
} from './exercise-findings';

const record = (over: Partial<ExerciseRecord> & Pick<ExerciseRecord, 'name'>): ExerciseRecord =>
  ({
    kind: 'action',
    outcome: 'reached',
    statements: 2,
    effects: [],
    ms: 3,
    ...over,
  }) as ExerciseRecord;

const RECORDS: readonly ExerciseRecord[] = [
  record({ name: 'createPost' }),
  record({
    name: 'publishPost',
    outcome: 'unreached',
    code: 'X_POST_NOT_FOUND',
    reason: 'postId matched no seeded row',
    override: "publishPost: { input: { postId: '<a posts id>' } }",
  }),
  record({ name: 'adminOnly', outcome: 'refused', code: 'X_FORBIDDEN' }),
  record({ name: 'sendInvoice', kind: 'job', outcome: 'off', reason: 'calls the bank' }),
];

describe('unit · exercise findings', () => {
  test('only unreached is a finding, under the code 39 registered', () => {
    const findings = exerciseFindings(RECORDS);
    expect(findings.map((finding) => finding.code)).toEqual(['X_CONTRACT_EXERCISE_UNREACHED']);
    expect(findings[0]?.at).toBe('apps/web/exercise.ts');
    expect(findings[0]?.cause).toContain('publishPost');
    expect(findings[0]?.cause).toContain('X_POST_NOT_FOUND');
  });

  test('the fix is the paste-ready override, then the one-primitive rerun', () => {
    const fix = exerciseFindings(RECORDS)[0]?.fix ?? '';
    expect(fix).toContain("publishPost: { input: { postId: '<a posts id>' } }");
    expect(fix).toContain('apps/web/exercise.ts');
    expect(fix).toContain('x exercise publishPost --json');
  });

  test('a record with no override still gets a fix naming the name, never a blank', () => {
    const [finding] = exerciseFindings([record({ name: 'shipOrder', outcome: 'unreached' })]);
    expect(finding?.fix).toContain('shipOrder: { input:');
    expect(finding?.fix).toContain('x exercise shipOrder --json');
  });

  test('a name a shell would split never reaches the rerun line', () => {
    const [finding] = exerciseFindings([record({ name: 'a b; rm', outcome: 'unreached' })]);
    expect(finding?.fix).toContain('x exercise <name> --json');
  });

  test('counts every outcome, and the report carries them beside the records', () => {
    expect(exerciseCounts(RECORDS)).toEqual({
      total: 4,
      reached: 1,
      refused: 1,
      unreached: 1,
      off: 1,
    });
    const report = exerciseReport(RECORDS, 7);
    expect(report.seed).toBe(7);
    expect(report.counts.unreached).toBe(1);
    expect(report.records).toHaveLength(4);
  });

  test('the table has one row per record, unreached first', () => {
    const lines = renderExerciseTable(RECORDS);
    expect(lines).toHaveLength(RECORDS.length + 1);
    expect(lines[1]).toContain('publishPost');
  });

  test('a crossed tenant verdict is red, one finding per leak; unproven and public are not', () => {
    const tenanted: readonly ExerciseRecord[] = [
      record({
        name: 'readPost',
        kind: 'query',
        tenant: {
          verdict: 'crossed',
          findings: [{ code: 'X_TENANT_LEAK', leg: 'before', path: 'output.title' }],
        },
      }),
      record({ name: 'inbox', kind: 'query', tenant: { verdict: 'unproven', reason: 'empty' } }),
      record({ name: 'health', tenant: { verdict: 'public', reason: 'anonymous' } }),
    ];
    const findings = exerciseFindings(tenanted);
    expect(findings.map((one) => [one.code, one.at])).toEqual([
      ['X_TENANT_LEAK', 'query readPost'],
    ]);
    expect(findings[0]?.fix).toStartWith('x exercise readPost --json');
    expect(renderExerciseTable(tenanted).join('\n')).toContain('crossed');
  });
});
