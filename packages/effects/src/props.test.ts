import { describe, expect, test } from 'bun:test';
import type { ColorRole } from '@ultimat3/ui';
import { rangeProp, rolesProp, roleVars } from './props';

const SPEED = { min: 0.25, max: 4, fallback: 1 } as const;

describe('unit · prop screens', () => {
  test('unset reads the fallback, an in-range value passes through', () => {
    expect(rangeProp('Aurora', 'speed', undefined, SPEED)).toBe(1);
    expect(rangeProp('Aurora', 'speed', 4, SPEED)).toBe(4);
  });

  test('out of range or not finite is X_EFFECTS_INVALID_VALUE naming entry, prop and range', () => {
    for (const bad of [0, 5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rangeProp('Aurora', 'speed', bad, SPEED)).toThrow(
        expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
      );
    }
    try {
      rangeProp('Aurora', 'speed', 9, SPEED);
      expect.unreachable('a speed of 9 was accepted');
    } catch (error) {
      expect(String((error as Error).message)).toContain('<Aurora speed> is 9, outside 0.25..4');
    }
  });

  test('roles: unknown names and wrong sizes are refused, known ones pass', () => {
    expect(rolesProp('Aurora', ['accent', 'info'], ['accent'], { min: 1, max: 3 })).toEqual([
      'accent',
      'info',
    ]);
    // Input from an untyped JavaScript caller: the type system would refuse it at the call site.
    const unknown = ['accent', 'hotpink'] as unknown as readonly ColorRole[];
    expect(() => rolesProp('Aurora', unknown, ['accent'], { min: 1, max: 3 })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
    expect(() => rolesProp('Aurora', [], ['accent'], { min: 1, max: 3 })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
  });

  test('a palette becomes role custom properties, never a colour literal', () => {
    expect(roleVars(['accent', 'chart-2'])).toEqual({
      '--fx-c0': 'var(--color-accent)',
      '--fx-c1': 'var(--color-chart-2)',
    });
  });
});
