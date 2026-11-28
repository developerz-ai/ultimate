import { describe, expect, test } from 'bun:test';
import { EFFECTS_ERROR_CODES, EffectsInvalidValueError } from './errors';

describe('unit · @ultimat3/effects errors', () => {
  test('the error carries a stable code, a cause and a fix', () => {
    const error = new EffectsInvalidValueError({
      cause: '<Aurora speed={-1}> is below 0.25',
      fix: '<Aurora speed={1} />   // any finite number from 0.25 to 4',
    });
    expect(error).toBeUltimateError('X_EFFECTS_INVALID_VALUE');
    expect(error.fix).toContain('<Aurora speed={1} />');
  });

  test('every declared code is namespaced and screaming snake case', () => {
    for (const code of EFFECTS_ERROR_CODES) {
      expect(code).toMatch(/^X_EFFECTS_[A-Z0-9_]+$/);
    }
  });
});
