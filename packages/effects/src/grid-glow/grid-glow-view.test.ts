import { describe, expect, test } from 'bun:test';
import { GRID_GLOW_BACKEND, gridGlowView } from './grid-glow-view';

describe('unit · GridGlow view', () => {
  test('defaults: accent glow, plain grid, glow on, CSS tier', () => {
    expect(gridGlowView({})).toEqual({
      vars: { '--fx-c0': 'var(--color-accent)', '--fx-speed': '1' },
      ground: 'grid',
      glow: true,
    });
    expect(GRID_GLOW_BACKEND).toBe('css');
  });

  test('scanlines pick the scanline ground; glow={false} drops the glow', () => {
    const view = gridGlowView({ scanlines: true, glow: false, role: 'info' });
    expect(view.ground).toBe('grid-scanlines');
    expect(view.glow).toBe(false);
    expect(view.vars['--fx-c0']).toBe('var(--color-info)');
  });

  test('a speed of 10 is X_EFFECTS_INVALID_VALUE', () => {
    expect(() => gridGlowView({ speed: 10 })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
  });
});
