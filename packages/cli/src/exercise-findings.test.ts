// What `x exercise` makes of a pass's records: `unreached` is a finding whose fix is the override to
// paste, every other outcome is not, and the report is the same document `--json` and
// `.x/exercise.json` carry.

import { describe, expect, test } from 'bun:test';
import type { ExerciseRecord } from '@ultimat3/testing';
import {
  crashFindingLines,
  exerciseCounts,
  exerciseFindings,
  exercisePhaseLine,
  exerciseReport,
  renderExerciseTable,
  slowestProofLines,
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
    // The one home: a declaration left inline in a contract test is the usual reason for this row.
    expect(fix).toContain('.contract({ exercise: {...} }) in a test is not read here');
  });

  // Thirty unreached primitives used to be thirty `defineExercise({ … })` calls to unwrap by hand:
  // into a file that exists, the fix is the ENTRY, pasted as-is inside the one export.
  test('into an existing exercise file the fix is the bare entry, pasteable as-is', () => {
    const fix = exerciseFindings(RECORDS, 'present')[0]?.fix ?? '';
    expect(fix).toStartWith("publishPost: { input: { postId: '<a posts id>' } },   # ");
    expect(fix).not.toContain('defineExercise({ publishPost');
    expect(fix).toContain('inside export const exercise = defineExercise({ … })');
  });

  // An app with no `apps/web/exercise.ts` (every app upgrading into the step) is handed the file.
  test('with no exercise file the fix is the whole file to create, entry inside', () => {
    const fix = exerciseFindings(RECORDS, 'absent')[0]?.fix ?? '';
    expect(fix).toStartWith(
      "import { defineExercise } from '@ultimat3/testing'; export const exercise = defineExercise({ publishPost: { input: { postId: '<a posts id>' } } });",
    );
    expect(fix).toContain('create apps/web/exercise.ts');
    expect(fix).toContain('x exercise publishPost --json');
  });

  test("an override's trailing comma is never doubled", () => {
    const [finding] = exerciseFindings(
      [record({ name: 'p', outcome: 'unreached', override: 'p: { off: "x" }, ' })],
      'present',
    );
    expect(finding?.fix).toStartWith('p: { off: "x" },   # ');
  });

  test('a record with no override still gets a fix naming the name, never a blank', () => {
    const [finding] = exerciseFindings([record({ name: 'shipOrder', outcome: 'unreached' })]);
    expect(finding?.fix).toContain('shipOrder: { input:');
    expect(finding?.fix).toContain('x exercise shipOrder --json');
  });

  test('a record carrying its own fix (a job on one fixed org) gets that fix, not a paste', () => {
    const fix = 'tenant: (input) => input.orgId   # in job({ name: "sweep" })\'s declaration';
    const [finding] = exerciseFindings([
      record({ name: 'sweep', outcome: 'unreached', code: 'X_JOB_TENANT_MISMATCH', fix }),
    ]);
    expect(finding).toMatchObject({ code: 'X_CONTRACT_EXERCISE_UNREACHED', fix });
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

  // plan 101 / 40-next-job-crash-proof: a reached job killed at a step boundary made an effect
  // more often than a clean run — a real double effect on retry, red in the gate.
  const leaky = record({
    name: 'chargeOrder',
    kind: 'job',
    crash: {
      verdict: 'diverged',
      boundaries: 4,
      reruns: 1,
      findings: [
        {
          boundary: 'charge',
          mode: 'clean',
          effect: 'row:payments:insert',
          clean: 1,
          killed: 2,
          after: 'create',
        },
        {
          boundary: 'mail',
          mode: 'clean',
          effect: 'row:payments:insert',
          clean: 1,
          killed: 2,
          after: 'create',
        },
        {
          boundary: 'mail',
          mode: 'clean',
          effect: 'mail:receipt→a@x.example',
          clean: 1,
          killed: 2,
        },
      ],
    },
  });

  test('a diverged crash proof is X_JOB_CRASH_DIVERGED, one finding per effect, every boundary named', () => {
    const findings = exerciseFindings([
      leaky,
      record({ name: 'held', kind: 'job', crash: { verdict: 'held', boundaries: 3, reruns: 0 } }),
      record({ name: 'odd', kind: 'job', crash: { verdict: 'unproven', reason: 'X_NOPE: no' } }),
    ]);
    expect(findings.map((one) => [one.code, one.at])).toEqual([
      ['X_JOB_CRASH_DIVERGED', 'job chargeOrder'],
      ['X_JOB_CRASH_DIVERGED', 'job chargeOrder'],
    ]);
    const [rows, mail] = findings;
    expect(rows?.cause).toContain('row:payments:insert');
    expect(rows?.cause).toContain('"charge", "mail"');
    expect(rows?.cause).toContain('2× against 1×');
    expect(rows?.fix).toStartWith('x exercise chargeOrder --json');
    expect(rows?.fix).toContain("step.run('<name>'");
    expect(rows?.fix).toContain('after step "create"');
    expect(mail?.fix).toContain('before the first step');
  });

  // A failing step's retry was reported "outside every step, before the first step": the effect
  // ran INSIDE the step, so the finding names that step and the idempotency key, not a wrap.
  test('a divergence made inside a step names the step, never "outside every step"', () => {
    const inside = record({
      name: 'syncFeed',
      kind: 'job',
      crash: {
        verdict: 'diverged',
        boundaries: 3,
        reruns: 0,
        findings: [
          {
            boundary: 'nack',
            mode: 'clean',
            effect: 'network:GET feeds.example/rss',
            clean: 2,
            killed: 3,
            inside: 'fetch',
          },
        ],
      },
    });
    const [finding] = exerciseFindings([inside]);
    expect(finding?.cause).toContain('inside step "fetch"');
    expect(finding?.cause).not.toContain('outside every step');
    expect(finding?.fix).toContain('jobId}:fetch');
  });

  // A 5xx carried only its code: every one had to be reproduced by hand to read its cause.
  test('an unreached 5xx carries its cause, statement and fields into the finding', () => {
    const [finding] = exerciseFindings([
      record({
        name: 'recordLedger',
        outcome: 'unreached',
        code: 'X_DB_STATEMENT_FAILED',
        reason: 'answered X_DB_STATEMENT_FAILED, a 500',
        defect: {
          cause:
            '[SQLSTATE 23502] null value in column "payload" — statement: insert into "ledger"',
          statement: 'insert into "ledger"',
          fields: ['items.0.sku'],
        },
      }),
    ]);
    expect(finding?.cause).toContain('null value in column \\"payload\\"');
    expect(finding?.cause).toContain('items.0.sku');
  });

  test('a job name a shell would split is a placeholder in the rerun', () => {
    const [finding] = exerciseFindings([{ ...leaky, name: 'a; rm -rf b' }]);
    expect(finding?.fix).toStartWith('x exercise <job> --json');
  });

  test('the table has a crash column, and one line per killed boundary', () => {
    expect(renderExerciseTable([leaky]).join('\n')).toContain('diverged');
    expect(renderExerciseTable([leaky])[0]).toContain('crash');
    expect(crashFindingLines([leaky, record({ name: 'createPost' })])).toEqual([
      'job chargeOrder · killed at charge · X_JOB_CRASH_DIVERGED row:payments:insert 2× (clean 1×)',
      'job chargeOrder · killed at mail · X_JOB_CRASH_DIVERGED row:payments:insert 2× (clean 1×)',
      'job chargeOrder · killed at mail · X_JOB_CRASH_DIVERGED mail:receipt→a@x.example 2× (clean 1×)',
    ]);
  });
});

// A 504-primitive pass ran 172 minutes against a sum of `ms` of 1.6 s: the time was in the proofs,
// and nothing in the report said which. Every record carries its proofs' time, the pass its phases.
describe('unit · exercise timings', () => {
  const slow = record({
    name: 'sweepHooks',
    kind: 'job',
    ms: 4,
    proofMs: { tenant: 12, crash: 9_000, scale: 30 },
  });
  const phases = { seed: 800, primitives: 9_100, scale: 400, plans: 250, subject: 60 };

  test('the table shows each proof’s ms beside the call’s own', () => {
    const [header, ...rows] = renderExerciseTable([slow, record({ name: 'off', outcome: 'off' })]);
    const row = rows.find((one) => one.includes('sweepHooks'));
    expect(header).toContain('tenant ms');
    expect(header).toContain('crash ms');
    expect(header).toContain('scale ms');
    expect(row?.split(/\s+/)).toEqual(expect.arrayContaining(['4', '12', '9000', '30']));
  });

  test('the report carries the phases, and the phase line names the slowest', () => {
    const report = exerciseReport([slow], 1, phases);
    expect(report.phases).toEqual(phases);
    const line = exercisePhaseLine(phases);
    expect(line).toContain('10610');
    expect(line).toContain('primitives 9100');
    expect(line).toContain('slowest: primitives');
  });

  test('the slowest proof is named by record, so a slow pass points at one job', () => {
    expect(slowestProofLines([slow, record({ name: 'fast', proofMs: { tenant: 1 } })])).toEqual([
      'slowest: job sweepHooks · crash 9000 ms',
      'slowest: action fast · tenant 1 ms',
    ]);
  });
});
