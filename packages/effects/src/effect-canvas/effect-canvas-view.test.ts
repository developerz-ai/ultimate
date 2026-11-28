import { describe, expect, test } from 'bun:test';
import { EFFECT_CANVAS_BACKEND, effectCanvasSpec } from './effect-canvas-view';

describe('unit · EffectCanvas view', () => {
  test('a draw alone wants canvas; a shader wants WebGL2 and keeps the draw as its fallback', () => {
    const draw = () => () => {};
    expect(effectCanvasSpec({ draw }).wants).toBe('canvas');
    const spec = effectCanvasSpec({ draw, shader: () => Promise.reject(new TypeError('unused')) });
    expect(spec.wants).toBe('webgl2');
    expect(spec.draw2d).toBe(draw);
  });

  test('server tier is static: the fallback is the frame', () => {
    expect(EFFECT_CANVAS_BACKEND).toBe('static');
  });

  test('nine roles is X_EFFECTS_INVALID_VALUE', () => {
    const roles = [
      'accent',
      'info',
      'success',
      'warning',
      'danger',
      'fg',
      'bg',
      'line',
      'scrim',
    ] as const;
    expect(() => effectCanvasSpec({ roles })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
  });
});
