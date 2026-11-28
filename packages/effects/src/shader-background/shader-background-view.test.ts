import { describe, expect, test } from 'bun:test';
import {
  dotsRamp,
  grainAngle,
  meshPoints,
  SHADER_BACKGROUND_BACKEND,
  type ShaderPreset,
  shaderBackgroundView,
} from './shader-background-view';

describe('unit · ShaderBackground view', () => {
  test('the server frame places the mesh points where frame 0 of the animation has them', () => {
    const view = shaderBackgroundView({});
    const [first] = meshPoints(0);
    if (first === undefined) return expect.unreachable('no mesh point');
    expect(view.vars['--fx-p0x']).toBe(`${Math.round(first[0] * 10_000) / 100}%`);
    expect(view.vars['--fx-p0y']).toBe(`${Math.round(first[1] * 10_000) / 100}%`);
    expect(view.vars['--fx-angle']).toBe(`${grainAngle(0)}deg`);
  });

  test('mesh points move and stay inside the box', () => {
    expect(meshPoints(0)).not.toEqual(meshPoints(3));
    for (let t = 0; t < 60; t += 1.3) {
      for (const [x, y] of meshPoints(t)) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(1);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(1);
      }
    }
  });

  test('the dots wave is absent at frame 0 and whole after two seconds', () => {
    expect(dotsRamp(0)).toBe(0);
    expect(dotsRamp(2)).toBe(1);
    expect(dotsRamp(9)).toBe(1);
  });

  test('defaults: mesh, four role references, static server tier', () => {
    const view = shaderBackgroundView({});
    expect(view.preset).toBe('mesh');
    expect(view.vars['--fx-c0']).toBe('var(--color-bg-soft)');
    expect(view.vars['--fx-c3']).toBe('var(--color-chart-3)');
    expect(SHADER_BACKGROUND_BACKEND).toBe('static');
  });

  test('an unknown preset or three roles is X_EFFECTS_INVALID_VALUE', () => {
    // Input from an untyped JavaScript caller: the type system would refuse it at the call site.
    const unknown = 'plasma' as unknown as ShaderPreset;
    expect(() => shaderBackgroundView({ preset: unknown })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
    expect(() => shaderBackgroundView({ roles: ['bg', 'accent', 'info'] })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
  });
});
