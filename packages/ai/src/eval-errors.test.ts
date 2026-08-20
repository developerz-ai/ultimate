// A `fix:` is copied and run verbatim (axiom 4), so the one thing worth pinning about these five
// classes is that the command each names is a command `x` actually accepts.

import { describe, expect, test } from 'bun:test';
import {
  EvalBaselineInvalidError,
  EvalBaselineMissingError,
  EvalMissingError,
  EvalRecordingError,
  EvalThresholdError,
} from './eval-errors';

/** `x test`'s positional is a TestType — `packages/cli/src/verify-tests.ts`'s `TEST_TYPES`. */
const TEST_TYPES = ['unit', 'contract', 'live', 'job', 'e2e', 'eval'];

const threshold = (name: string): EvalThresholdError =>
  new EvalThresholdError({
    eval: name,
    score: 0.667,
    baseline: 1,
    tolerance: 0.05,
    promptVersion: 'summarize@1.0.0',
    regressed: ['refund'],
  });

describe('X_EVAL_THRESHOLD names a runnable command', () => {
  test('the eval reaches `x test` through --filter, never as the positional', () => {
    const { fix } = threshold('summarize').toJSON();
    // `x test summarize` is X_CLI_BAD_FLAG: "summarize" is not a test type. This is the
    // assertion that fails if the name is ever put back in the positional slot.
    expect(fix).not.toMatch(/x test summarize\b/);
    expect(fix).toContain('x test eval --filter summarize');
  });

  test('every `x test <word>` it names is a real test type', () => {
    for (const name of ['summarize', 'eval', 'unit']) {
      const { fix } = threshold(name).toJSON();
      // `''` rather than `undefined`: the group always matches when the regex does, and an
      // empty positional is not a test type either, so an impossible case still fails loudly.
      for (const [, positional = ''] of fix.matchAll(/\bx test ([a-z0-9-]+)/g)) {
        expect(TEST_TYPES).toContain(positional);
      }
    }
  });
});

describe('the other four fix lines stay on `x test eval`', () => {
  const cases: readonly [string, { readonly fix: string | undefined }][] = [
    [
      'X_EVAL_BASELINE_MISSING',
      new EvalBaselineMissingError({
        eval: 'summarize',
        path: './summarize.baseline.json',
        reason: 'does not exist',
      }).toJSON(),
    ],
    [
      'X_EVAL_BASELINE_INVALID',
      new EvalBaselineInvalidError({
        path: './summarize.baseline.json',
        problem: 'is not JSON',
      }).toJSON(),
    ],
    ['X_EVAL_MISSING', new EvalMissingError({ prompt: 'summarize', id: 'summarize' }).toJSON()],
    ['X_EVAL_RECORDING', new EvalRecordingError({ env: 'ULTIMATE_EVAL_RECORD' }).toJSON()],
  ];

  for (const [code, json] of cases) {
    test(`${code} cites only real test types`, () => {
      const fix = json.fix ?? '';
      expect(fix.length).toBeGreaterThan(0);
      // `''` rather than `undefined`: the group always matches when the regex does, and an
      // empty positional is not a test type either, so an impossible case still fails loudly.
      for (const [, positional = ''] of fix.matchAll(/\bx test ([a-z0-9-]+)/g)) {
        expect(TEST_TYPES).toContain(positional);
      }
    });
  }
});
