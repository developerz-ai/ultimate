// An unreached primitive's fix when a paste cannot help: a policy predicate that returned false
// points at the predicate, an entry the file already holds is edited in place — never a second key
// (TS1117) — and neither carries the run's drawn ids, so two runs print the same fix.

import { describe, expect, test } from 'bun:test';
import type { ExerciseOverride, ExerciseOverrides, ExerciseRecord } from '@ultimat3/testing';
import { exerciseFindings } from './exercise-findings';

const unreached = (over: Partial<ExerciseRecord>): ExerciseRecord =>
  ({
    kind: 'action',
    name: 'archiveInvoice',
    outcome: 'unreached',
    statements: 0,
    effects: [],
    ms: 3,
    code: 'X_FORBIDDEN',
    override: 'archiveInvoice: { input: (drawn) => ({ ...drawn, orgId: "0f1c8195-aaaa" }) }',
    ...over,
  }) as ExerciseRecord;

const overrides = (...keys: readonly string[]): ExerciseOverrides => ({
  kind: 'exercise-overrides',
  entries: new Map<string, ExerciseOverride>(keys.map((key) => [key, { off: 'a fixture entry' }])),
});

const fixOf = (record: ExerciseRecord, file?: ExerciseOverrides) =>
  exerciseFindings([record], file)[0]?.fix ?? '';

describe('unit · exercise unreached fix', () => {
  test('a predicate that returned false points at the policy, never a paste', () => {
    const fix = fixOf(unreached({ reason: 'invoice:write predicate returned false' }), overrides());
    expect(fix).toStartWith("edit the predicate of can('invoice:write', …)");
    expect(fix).toContain('x policy explain archiveInvoice --json');
    expect(fix).toEndWith('then: x exercise archiveInvoice --json');
    expect(fix).toContain('apps/web/app/invoice/policy.ts');
    expect(fix).not.toContain('0f1c8195');
    expect(fix).not.toContain('paste inside');
  });

  test('the policy fix is the same whatever ids the run drew', () => {
    const reason = 'invoice:write predicate returned false';
    expect(fixOf(unreached({ reason, override: 'archiveInvoice: { input: "a" }' }))).toBe(
      fixOf(unreached({ reason, override: 'archiveInvoice: { input: "b" }' })),
    );
  });

  test('an entry the file already holds is edited in place, never pasted twice', () => {
    for (const key of ['archiveInvoice', 'action:archiveInvoice']) {
      const fix = fixOf(
        unreached({ code: 'X_INVOICE_NOT_FOUND', reason: 'no row' }),
        overrides(key),
      );
      expect(fix).toStartWith('edit the archiveInvoice entry already in apps/web/exercise.ts');
      expect(fix).toEndWith('then: x exercise archiveInvoice --json');
      expect(fix).toContain('TS1117');
      expect(fix).not.toContain('0f1c8195');
    }
  });

  test('an entry already there and a false predicate: the predicate wins', () => {
    const fix = fixOf(
      unreached({ reason: 'invoice:write predicate returned false' }),
      overrides('archiveInvoice'),
    );
    expect(fix).toStartWith('edit the predicate of');
  });

  test('a file with no entry for it still gets the paste', () => {
    const fix = fixOf(unreached({ reason: 'no row' }), overrides('otherAction'));
    expect(fix).toStartWith('archiveInvoice: { input:');
    expect(fix).toContain('paste inside');
  });
});
