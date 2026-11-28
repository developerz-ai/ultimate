import { describe, expect, test } from 'bun:test';
import { FakeContext2d } from '../fake-host-fixture';
import type { Rgb } from '../palette';
import { presetCanvas } from './shader-background-canvas';
import { DOT_PITCH, DOT_RADIUS, meshPoints } from './shader-background-view';

const PALETTE: readonly Rgb[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const frame = (time: number) => ({ time, width: 100, height: 100, scale: 2 });
const asCtx = (ctx: FakeContext2d): CanvasRenderingContext2D =>
  ctx as unknown as CanvasRenderingContext2D;

describe('unit · ShaderBackground on Canvas2D', () => {
  test('mesh: the ground, then one ellipse per point at meshPoints(t), transform restored', () => {
    const ctx = new FakeContext2d();
    presetCanvas('mesh', () => PALETTE)(asCtx(ctx), frame(0));
    const transforms = ctx.calls.filter((c) => c[0] === 'setTransform');
    const [x, y] = meshPoints(0)[0] ?? [0, 0];
    expect(transforms[0]).toEqual([
      'setTransform',
      2 * 0.6 * 100,
      0,
      0,
      2 * 0.6 * 100,
      2 * x * 100,
      2 * y * 100,
    ]);
    expect(transforms).toHaveLength(4);
    expect(transforms.at(-1)).toEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
    expect(ctx.calls.filter((c) => c[0] === 'createRadialGradient')).toHaveLength(3);
    expect(ctx.calls.find((c) => c[0] === 'stop')).toEqual(['stop', 0, 'rgb(255 0 0 / 0.9)']);
  });

  test('grain: the gradient line CSS draws for 135deg runs corner to corner', () => {
    const ctx = new FakeContext2d();
    presetCanvas('grain', () => PALETTE)(asCtx(ctx), frame(0));
    const line = ctx.calls.find((c) => c[0] === 'createLinearGradient') ?? [];
    expect(line.slice(1).map((n) => Math.round(Number(n)) + 0)).toEqual([0, 0, 100, 100]);
  });

  test('dots: one dot per pitch cell, every one the server radius at frame 0', () => {
    const ctx = new FakeContext2d();
    presetCanvas('dots', () => PALETTE)(asCtx(ctx), frame(0));
    const arcs = ctx.calls.filter((c) => c[0] === 'arc');
    expect(arcs).toHaveLength(Math.ceil(100 / DOT_PITCH) ** 2);
    expect(new Set(arcs.map((c) => c[3]))).toEqual(new Set([DOT_RADIUS]));
    const later = new FakeContext2d();
    presetCanvas('dots', () => PALETTE)(asCtx(later), frame(5));
    expect(
      new Set(later.calls.filter((c) => c[0] === 'arc').map((c) => c[3])).size,
    ).toBeGreaterThan(1);
  });

  test('an unresolved palette draws nothing rather than a guess', () => {
    for (const preset of ['mesh', 'grain', 'dots'] as const) {
      const ctx = new FakeContext2d();
      presetCanvas(preset, () => [])(asCtx(ctx), frame(0));
      expect(ctx.calls).toEqual([]);
    }
  });
});
