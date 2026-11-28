import { describe, expect, test } from 'bun:test';
import { AURORA_BACKEND, auroraVars } from './aurora-view';

describe('unit · Aurora view', () => {
  test('defaults: three role bands, half intensity, speed 1', () => {
    expect(auroraVars({})).toEqual({
      '--fx-c0': 'var(--color-accent)',
      '--fx-c1': 'var(--color-info)',
      '--fx-c2': 'var(--color-success)',
      '--fx-intensity': '0.5',
      '--fx-speed': '1',
    });
  });

  test('is the CSS tier', () => {
    expect(AURORA_BACKEND).toBe('css');
  });

  test('two roles, an intensity past 1 or a speed of 0 is X_EFFECTS_INVALID_VALUE', () => {
    const bad = [{ roles: ['accent', 'info'] as const }, { intensity: 2 }, { speed: 0 }];
    for (const input of bad) {
      expect(() => auroraVars(input)).toThrow(
        expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
      );
    }
  });
});
