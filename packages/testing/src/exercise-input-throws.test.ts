// An override's `input` that throws is that primitive's record, never the pass's failure: unreached,
// under the throw's own code (or X_EXERCISE_INPUT_THREW for an uncoded one), its fix naming the
// entry — and the pass returns. A throw on a later call (the scale sweep's) is that sweep's.

import { describe, expect, test } from 'bun:test';
import { action, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { UltimateError } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import type { ExerciseOverride } from './define-exercise';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const writer: SeedWriter = {
  insert: async () => undefined,
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

const answers = () =>
  action({
    input: t.object({ word: t.string.max(20) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the input binder is the subject here, not the policy'),
    handle: () => ({ ok: true }),
  });
registerActions({
  eitUncoded: answers(),
  eitCoded: answers(),
  eitControl: answers(),
  eitLate: answers(),
});

const pass = async (only: string, entry: ExerciseOverride): Promise<ExerciseRecord> => {
  const records = await runExercisePass({
    entities: [],
    writer,
    roles: () => [{ name: 'anonymous', actor: null }],
    only,
    overrides: defineExercise({ [only]: entry }),
  });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
};

// Each bind's failure is INPUT to the pass — built here, handed over — never this file's verdict.
const FIXTURE_BROKE = new TypeError('the fixture broke');
const SECOND_CALL_BROKE = new TypeError('the second call broke');
const ONCE_PER_PASS = new TypeError('only once per pass');

describe(testName('unit', 'runExercisePass · an override input that throws'), () => {
  test('an uncoded throw is that primitive unreached under X_EXERCISE_INPUT_THREW', async () => {
    const record = await pass('eitUncoded', {
      input: async () => {
        throw FIXTURE_BROKE;
      },
    });
    expect(record).toMatchObject({
      kind: 'action',
      name: 'eitUncoded',
      outcome: 'unreached',
      code: 'X_EXERCISE_INPUT_THREW',
      tenant: { verdict: 'unproven' },
    });
    expect(record.reason).toContain('TypeError');
    expect(record.reason).toContain('the fixture broke');
    // Not a defect: the throw is the app's exercise.ts, never the handler.
    expect(record.defect).toBeUndefined();
    expect(record.fix).toStartWith('x exercise eitUncoded --json');
    expect(record.fix).toContain('eitUncoded: { input }');
    expect(record.fix).toContain('apps/web/exercise.ts');
  });

  test('a coded throw keeps its own code and cause', async () => {
    const record = await pass('eitCoded', {
      input: () => {
        throw new UltimateError({
          code: 'X_EIT_CHALLENGE_GONE',
          cause: 'the challenge expired',
          fix: 'issue a fresh one',
        });
      },
    });
    expect(record).toMatchObject({ outcome: 'unreached', code: 'X_EIT_CHALLENGE_GONE' });
    expect(record.reason).toContain('the challenge expired');
  });

  test("a throw inside the control's own loop is the same record, never the pass's", async () => {
    let calls = 0;
    const record = await pass('eitControl', {
      input: (drawn) => {
        calls += 1;
        // The tenant proof's first input binds; the control's run is the one that throws.
        if (calls > 1) throw SECOND_CALL_BROKE;
        return { ...drawn, word: 'ok' };
      },
    });
    expect(record).toMatchObject({ outcome: 'unreached', code: 'X_EXERCISE_INPUT_THREW' });
    expect(record.reason).toContain('the second call broke');
    expect(record.fix).toContain('eitControl: { input }');
  });

  test('a throw only on a later call: reached, and the scale sweep unproven', async () => {
    let calls = 0;
    const record = await pass('eitLate', {
      input: (drawn) => {
        calls += 1;
        // The tenant proof's first input and the control's run; every later one is the sweep's.
        if (calls > 2) throw ONCE_PER_PASS;
        return { ...drawn, word: 'ok' };
      },
    });
    expect(record.outcome).toBe('reached');
    expect(record.scale).toMatchObject({ verdict: 'unproven' });
  });
});
