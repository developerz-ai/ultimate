import { describe, expect, test } from 'bun:test';
import {
  changedPercent,
  channelLimit,
  DIFF_RED,
  diffPixels,
  FADE_ALPHA,
  FADE_GROUND,
  faded,
} from './ui-diff';

/** A `width`×`height` RGBA buffer filled with one pixel. */
const solid = (width: number, height: number, rgba: readonly number[]): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) out.set(rgba, i * 4);
  return out;
};

const pixelAt = (buffer: Uint8ClampedArray, x: number, y: number, width: number): number[] =>
  Array.from(buffer.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));

describe('unit · diffPixels counts, boxes and paints', () => {
  test('identical images: nothing changed, no box, every pixel faded', () => {
    const image = solid(3, 2, [10, 20, 30, 255]);
    const result = diffPixels(image, image, 3, 2, 0.1);
    expect(result.changedPixels).toBe(0);
    expect(result.changedBox).toBeNull();
    expect(pixelAt(result.diffRgba, 2, 1, 3)).toEqual([faded(10), faded(20), faded(30), 255]);
  });

  test('one changed pixel: count 1, a 1×1 box at its coordinates, painted red', () => {
    const before = solid(4, 3, [0, 0, 0, 255]);
    const after = solid(4, 3, [0, 0, 0, 255]);
    after.set([255, 255, 255, 255], (2 * 4 + 3) * 4);
    const result = diffPixels(before, after, 4, 3, 0.1);
    expect(result.changedPixels).toBe(1);
    expect(result.changedBox).toEqual({ x: 3, y: 2, width: 1, height: 1 });
    expect(pixelAt(result.diffRgba, 3, 2, 4)).toEqual([...DIFF_RED]);
    expect(pixelAt(result.diffRgba, 0, 0, 4)).toEqual([faded(0), faded(0), faded(0), 255]);
  });

  test('the box spans the extreme changed pixels, not the pixels between', () => {
    const before = solid(5, 5, [0, 0, 0, 255]);
    const after = solid(5, 5, [0, 0, 0, 255]);
    after.set([255, 0, 0, 255], (1 * 5 + 1) * 4);
    after.set([255, 0, 0, 255], (3 * 5 + 4) * 4);
    const result = diffPixels(before, after, 5, 5, 0.1);
    expect(result.changedPixels).toBe(2);
    expect(result.changedBox).toEqual({ x: 1, y: 1, width: 4, height: 3 });
  });

  test('the threshold is a strict per-channel bound: a delta AT the limit is unchanged', () => {
    // threshold 0.1 → limit 25.5: a delta of 25 is noise, 26 is a change.
    expect(channelLimit(0.1)).toBe(25.5);
    const before = solid(1, 1, [100, 100, 100, 255]);
    const same = solid(1, 1, [125, 100, 100, 255]);
    const moved = solid(1, 1, [126, 100, 100, 255]);
    expect(diffPixels(before, same, 1, 1, 0.1).changedPixels).toBe(0);
    expect(diffPixels(before, moved, 1, 1, 0.1).changedPixels).toBe(1);
    // threshold 0: any difference counts; threshold 1: none can, the range is 255.
    expect(diffPixels(before, solid(1, 1, [101, 100, 100, 255]), 1, 1, 0).changedPixels).toBe(1);
    expect(diffPixels(before, solid(1, 1, [255, 0, 0, 0]), 1, 1, 1).changedPixels).toBe(0);
    // Out-of-range thresholds clamp rather than invert.
    expect(channelLimit(-3)).toBe(0);
    expect(channelLimit(7)).toBe(255);
  });

  test('an alpha-only change is a change: the fourth channel is compared too', () => {
    const before = solid(1, 1, [0, 0, 0, 255]);
    const after = solid(1, 1, [0, 0, 0, 0]);
    expect(diffPixels(before, after, 1, 1, 0.5).changedPixels).toBe(1);
  });

  test('the fade is a quarter of the after pixel over the ground, opaque', () => {
    expect(FADE_ALPHA).toBe(0.25);
    expect(faded(0)).toBe(Math.round(FADE_GROUND * 0.75));
    expect(faded(255)).toBe(Math.round(255 * 0.25 + FADE_GROUND * 0.75));
    const before = solid(1, 1, [0, 0, 0, 255]);
    const after = solid(1, 1, [0, 0, 0, 255]);
    // The AFTER pixel is what fades, and its own alpha does not leak into the diff's.
    after.set([200, 100, 0, 128], 0);
    const result = diffPixels(before, after, 1, 1, 1);
    expect(pixelAt(result.diffRgba, 0, 0, 1)).toEqual([faded(200), faded(100), faded(0), 255]);
  });
});

describe('unit · changedPercent', () => {
  test('two decimals, and zero for an empty image', () => {
    expect(changedPercent(1, 3, 1)).toBe(33.33);
    expect(changedPercent(2, 3, 1)).toBe(66.67);
    expect(changedPercent(0, 10, 10)).toBe(0);
    expect(changedPercent(100, 10, 10)).toBe(100);
    expect(changedPercent(0, 0, 0)).toBe(0);
  });
});
