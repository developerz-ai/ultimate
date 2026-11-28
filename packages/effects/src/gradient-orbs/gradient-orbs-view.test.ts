import { describe, expect, test } from 'bun:test';
import { gradientOrbsView, orbLayout, orbVars } from './gradient-orbs-view';

describe('unit · GradientOrbs view', () => {
  test('placement is a function of the index alone: the server and the island agree', () => {
    expect(orbLayout(['accent', 'info'])).toEqual(orbLayout(['accent', 'info']));
    const [first, second] = orbLayout(['accent', 'info']);
    expect(first).toEqual({ role: 'accent', x: 68, y: 50, size: 34, phase: 0 });
    expect(second?.phase).toBe(0.38);
  });

  test('every orb stays centred inside the box', () => {
    for (const orb of orbLayout(['accent', 'info', 'chart-3', 'success', 'warning', 'danger'])) {
      expect(orb.x).toBeGreaterThan(0);
      expect(orb.x).toBeLessThan(100);
      expect(orb.y).toBeGreaterThan(0);
      expect(orb.y).toBeLessThan(100);
    }
  });

  test('an orb carries its colour as a role reference, never a value', () => {
    const [orb] = orbLayout(['accent']);
    if (orb === undefined) return expect.unreachable('no orb for one role');
    expect(orbVars(orb)['--fx-c']).toBe('var(--color-accent)');
  });

  test('seven orbs or a negative speed is X_EFFECTS_INVALID_VALUE', () => {
    const seven = [
      'accent',
      'info',
      'chart-1',
      'chart-2',
      'chart-3',
      'chart-4',
      'chart-5',
    ] as const;
    expect(() => gradientOrbsView({ roles: seven })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
    expect(() => gradientOrbsView({ speed: -1 })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
  });
});
