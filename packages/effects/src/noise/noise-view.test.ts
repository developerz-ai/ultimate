import { describe, expect, test } from 'bun:test';
import { NOISE_BACKEND, NOISE_TURBULENCE, noiseView } from './noise-view';

describe('unit · Noise view', () => {
  test('defaults: a faint fg grain, static tier, a fixed seed', () => {
    expect(noiseView({})).toEqual({
      vars: { '--fx-opacity': '0.12', '--fx-c0': 'var(--color-fg)' },
    });
    expect(NOISE_BACKEND).toBe('static');
    expect(Object.isFrozen(NOISE_TURBULENCE)).toBe(true);
  });

  test('an opacity past 1 is X_EFFECTS_INVALID_VALUE', () => {
    expect(() => noiseView({ opacity: 1.5 })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
  });
});
