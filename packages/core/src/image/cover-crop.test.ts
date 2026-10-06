// Single responsibility: proves a `cover` whose aspect disagrees with the box never resamples the
// WHOLE source past the box. Resample-then-crop drew a 1x200 strip at 1000x200000 to keep a
// 1000x1000 window of it — 200 megapixels, three times the decompression-bomb ceiling, from a
// 200-pixel input. The visible region is cut from the source first, then resampled to the box.

import { describe, expect, test } from 'bun:test';
import { layOut } from './canvas';
import { transformImageBytes } from './pipeline';
import { decodeImage, encodeImage } from './png-pixels';
import { createRaster, MAX_IMAGE_PIXELS, type Raster } from './raster';

type Rgba = readonly [number, number, number, number];
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];

/** A 1-pixel-wide strip: rows `[0, 80)` red, `[80, 120)` green, `[120, 200)` blue. */
const strip = (): Raster => {
  const raster = createRaster(1, 200, 'test');
  for (let y = 0; y < 200; y += 1) {
    raster.pixels.set(y < 80 ? RED : y < 120 ? GREEN : BLUE, y * 4);
  }
  return raster;
};

const at = (raster: Raster, x: number, y: number): readonly number[] => [
  ...raster.pixels.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4),
];

describe('cover with an aspect mismatch', () => {
  test('nothing is drawn larger than the box, and the source region is the visible one', () => {
    const layout = layOut({ width: 1, height: 200 }, { width: 1000, height: 1000, fit: 'cover' });
    expect(layout.box).toEqual({ width: 1000, height: 1000 });
    expect(layout.drawn.width * layout.drawn.height).toBeLessThanOrEqual(1000 * 1000);
    // The centre square of a 1x200 strip is its one middle pixel.
    expect(layout.crop).toEqual({ x: 0, y: 100, width: 1, height: 1 });
  });

  // A ROUNDED window shifted a .5 offset half a source pixel off centre: 10x10 into 40x20 took
  // rows 3–8 of an exact 2.5–7.5. The covering window (floor to ceil) is clipped back to centre.
  test('a small source upscaled crops the whole pixels covering the exact window', () => {
    const layout = layOut({ width: 10, height: 10 }, { width: 40, height: 20, fit: 'cover' });
    expect(layout.crop).toEqual({ x: 0, y: 2, width: 10, height: 6 });
    // One scaled source pixel (4 px) a side over the inner 40x20, clipped evenly by composeOnto.
    expect(layout.drawn).toEqual({ width: 40, height: 24 });
  });

  test('a skinny strip covers a large box from its centre, within the pixel budget', async () => {
    const out = decodeImage(
      await transformImageBytes(encodeImage(strip()), { width: 1000, height: 1000, fit: 'cover' }),
    );
    expect([out.width, out.height]).toEqual([1000, 1000]);
    // Every corner shows the centre band: the red top and blue bottom were cropped away.
    for (const [x, y] of [
      [0, 0],
      [999, 0],
      [0, 999],
      [999, 999],
      [500, 500],
    ] as const) {
      expect([x, y, ...at(out, x, y)]).toEqual([x, y, ...GREEN]);
    }
    expect(MAX_IMAGE_PIXELS).toBeLessThan(1000 * 200_000);
  });

  test('padding still frames the cropped artwork', async () => {
    const out = decodeImage(
      await transformImageBytes(encodeImage(strip()), {
        width: 100,
        height: 100,
        fit: 'cover',
        padding: 0.1,
      }),
    );
    expect(at(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(out, 50, 50)).toEqual([...GREEN]);
  });

  test('a downscaling cover keeps resampling first — it never draws past the source', () => {
    const layout = layOut({ width: 400, height: 100 }, { width: 50, height: 50, fit: 'cover' });
    expect(layout.crop).toBeUndefined();
    expect(layout.drawn).toEqual({ width: 200, height: 50 });
  });
});
