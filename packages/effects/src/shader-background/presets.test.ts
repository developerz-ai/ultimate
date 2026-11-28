// The three preset programs, read as text and run as uniform factories: every uniform the GLSL
// declares is fed each frame and nothing else is, frame 0 hands the shader the server frame's
// numbers, and each is GLSL ES 3.00 (the line the lazy-chunk byte test looks for).

import { describe, expect, test } from 'bun:test';
import type { Rgb } from '../palette';
import type { ShaderProgram } from '../shader-mount';
import { loadPreset } from './load-preset';
import { MESH_STOPS } from './shader-background-canvas';
import { meshPoints, SHADER_PRESETS } from './shader-background-view';

const COLOURS: readonly Rgb[] = [
  [0.1, 0.1, 0.1],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const FRAME = { time: 0, width: 800, height: 600, scale: 2 };

const declared = (source: string): string[] =>
  [...source.matchAll(/^uniform \w+ (\w+)/gm)].map((match) => match[1] ?? '').sort();

const programs = new Map<string, ShaderProgram>();
for (const preset of SHADER_PRESETS) {
  programs.set(
    preset,
    (await loadPreset(preset))(() => COLOURS),
  );
}

describe('unit · shader presets', () => {
  for (const preset of SHADER_PRESETS) {
    test(`${preset}: GLSL ES 3.00 in both stages, every declared uniform fed`, () => {
      const program = programs.get(preset) ?? expect.unreachable(`no ${preset} program`);
      expect(program.vertex.startsWith('#version 300 es\n')).toBe(true);
      expect(program.fragment.startsWith('#version 300 es\n')).toBe(true);
      expect(Object.keys(program.uniforms(FRAME)).sort()).toEqual(declared(program.fragment));
    });
  }

  test('mesh: frame 0 hands the shader the points the server painted', () => {
    const program = programs.get('mesh') ?? expect.unreachable('no mesh program');
    const points = program.uniforms(FRAME)['u_points'] ?? expect.unreachable('no u_points');
    expect(points[0]).toBe('2fv');
    expect([...(points[1] as Float32Array)]).toEqual(meshPoints(0).flat().map(Math.fround));
  });

  test('the palette reaches the shader as twelve floats, in role order', () => {
    const program = programs.get('dots') ?? expect.unreachable('no dots program');
    const colours = program.uniforms(FRAME)['u_colors'] ?? expect.unreachable('no u_colors');
    expect([...(colours[1] as Float32Array)]).toEqual(COLOURS.flat().map(Math.fround));
  });

  test("the server's mesh stops are the canvas's and the shader's falloff", async () => {
    const sheet = await Bun.file(new URL('./ShaderBackground.module.scss', import.meta.url)).text();
    const alphas = [...sheet.matchAll(/rgb\(\$c \/ ([\d.]+)\) (\d+)%/g)].map((m) => [
      Number(m[2]) / 100,
      Number(m[1]),
    ]);
    expect(alphas).toHaveLength(MESH_STOPS.length);
    MESH_STOPS.forEach(([offset, alpha], index) => {
      expect(alphas[index]?.[0]).toBe(offset);
      expect(alphas[index]?.[1]).toBeCloseTo(alpha, 3);
    });
  });
});
