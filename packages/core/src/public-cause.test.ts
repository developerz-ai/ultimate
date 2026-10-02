// Single responsibility: pins the public-cause predicate — which 5xx codes may show their cause,
// that everything else is hidden by default, and that the app half is a registration, not a guess.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  hasPublicCause as barrelHasPublicCause,
  registerPublicCause as barrelRegisterPublicCause,
} from './index';
import { hasPublicCause, registerPublicCause, resetPublicCauses } from './public-cause';

afterEach(() => {
  resetPublicCauses();
});

describe('hasPublicCause', () => {
  test.each(['X_DRAINING', 'X_OVERLOADED', 'X_FLIGHT_GATE_OVERLOADED', 'X_TIMEOUT'])(
    '%s is a refusal whose cause IS the instruction',
    (code) => {
      expect(hasPublicCause(code)).toBe(true);
    },
  );

  test.each(['X_DB_STATEMENT_FAILED', 'X_INVARIANT', 'X_APP_UNKNOWN', '', 'toString', '__proto__'])(
    '%p is hidden — the default for every code nobody declared',
    (code) => {
      expect(hasPublicCause(code)).toBe(false);
    },
  );

  test('an app code becomes public by registration, and the reset withdraws only the app half', () => {
    registerPublicCause('X_BILLING_PROVIDER_DOWN');
    expect(hasPublicCause('X_BILLING_PROVIDER_DOWN')).toBe(true);
    resetPublicCauses();
    expect(hasPublicCause('X_BILLING_PROVIDER_DOWN')).toBe(false);
    expect(hasPublicCause('X_TIMEOUT')).toBe(true);
  });

  test('the barrel exports the predicate by name, so every renderer imports the same one', () => {
    expect(barrelHasPublicCause).toBe(hasPublicCause);
    expect(barrelRegisterPublicCause).toBe(registerPublicCause);
  });
});
