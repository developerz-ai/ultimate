// A primitive reached with no statement and no effect carries its entry's `empty` reason — the
// one way an app says the vacuous reach is right — and a reach with either never does.

import { describe, expect, test } from 'bun:test';
import { defineExercise } from './define-exercise';
import { withEmptyWhy } from './exercise-judge';
import type { ExerciseRecord } from './exercise-report';
import { testName } from './test-types';

const record = (over: Partial<ExerciseRecord> = {}): ExerciseRecord => ({
  kind: 'action',
  name: 'issueKey',
  outcome: 'reached',
  statements: 0,
  effects: [],
  ms: 1,
  ...over,
});

describe(testName('unit', 'withEmptyWhy'), () => {
  const overrides = defineExercise({ issueKey: { empty: ' signs a token: no row, no send ' } });

  test('the entry’s reason, trimmed, on a vacuous reach', () => {
    expect(withEmptyWhy(record(), overrides).empty).toBe('signs a token: no row, no send');
  });

  test('never on a reach with a statement, an effect, or one not reached', () => {
    expect(withEmptyWhy(record({ statements: 1 }), overrides).empty).toBeUndefined();
    const effects = [{ kind: 'mail' as const, mail: 'x', count: 1 }];
    expect(withEmptyWhy(record({ effects }), overrides).empty).toBeUndefined();
    expect(withEmptyWhy(record({ outcome: 'unreached' }), overrides).empty).toBeUndefined();
  });

  test('none without the entry', () => {
    expect(withEmptyWhy(record(), defineExercise({})).empty).toBeUndefined();
    expect(withEmptyWhy(record(), undefined).empty).toBeUndefined();
  });
});
