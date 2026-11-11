// `X_E2E_APP_FAILED` keeps its own code, and lifts the first inner coded finding the app's process
// printed: its code leads the cause and its fix is the fix — `x dev --json` is no answer to a seed
// row its entity refuses.

import { describe, expect, test } from 'bun:test';
import { E2eAppFailedError } from './e2e-errors';

const SEED_OUTPUT = [
  'seed  tier  status  ms',
  'X_INVARIANT_VIOLATED (packages/db/seeds/dev.ts)',
  '  cause: column.money-minor-units: got the float 19.99',
  "  fix:   { minor: Math.round(amount * 100), currency: 'EUR' }",
  '  docs:  https://example.invalid/errors',
  'X_CLI_UNEXPECTED',
  '  cause: something later',
  '  fix:   x doctor --json',
].join('\n');

describe('unit · X_E2E_APP_FAILED lifts the inner code', () => {
  test('the inner code leads the cause and its fix is the fix', () => {
    const error = new E2eAppFailedError({ step: 'x db seed', output: SEED_OUTPUT });
    expect(error.code).toBe('X_E2E_APP_FAILED');
    expect(error.inner?.code).toBe('X_INVARIANT_VIOLATED');
    expect(error.cause).toStartWith('"x db seed" failed for the e2e app with X_INVARIANT_VIOLATED');
    expect(error.cause).toContain('got the float 19.99');
    expect(error.fix).toBe("{ minor: Math.round(amount * 100), currency: 'EUR' }");
  });

  test('output with no coded finding keeps the generic fix', () => {
    const error = new E2eAppFailedError({ step: 'x db reset', output: 'segfault' });
    expect(error.inner).toBeUndefined();
    expect(error.fix).toStartWith('x dev --json');
  });

  test("a caller's literal fix still wins over a lifted one", () => {
    const error = new E2eAppFailedError({ step: 's', output: SEED_OUTPUT, fix: 'bun add -d x' });
    expect(error.fix).toBe('bun add -d x');
  });
});
