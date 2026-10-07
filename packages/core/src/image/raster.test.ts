// Single responsibility: proves the one in-memory representation's invariants — the
// decompression-bomb ceiling is checked BEFORE allocation, a buffer can never disagree with the
// size it claims, and `hasAlpha` is what every "PNG or JPEG?" decision downstream rests on.

import { describe, expect, test } from 'bun:test';
import { ImageDecodeFailedError, ImageTooLargeError } from './errors';
import {
  assertPixelBudget,
  blankRaster,
  cropRaster,
  hasAlpha,
  MAX_IMAGE_PIXELS,
  type Raster,
  rasterFrom,
} from './raster';

const thrown = (run: () => unknown): { code: string; cause: string; meta: unknown } => {
  try {
    run();
    return { code: 'no-throw', cause: 'no-throw', meta: undefined };
  } catch (error) {
    if (error instanceof ImageTooLargeError || error instanceof ImageDecodeFailedError) {
      return { code: error.code, cause: error.cause, meta: error.meta };
    }
    return { code: `unexpected: ${String(error)}`, cause: '', meta: undefined };
  }
};

const opaque = (width: number, height: number): Raster => {
  const raster = blankRaster(width, height, 'test');
  for (let i = 3; i < raster.pixels.length; i += 4) raster.pixels[i] = 255;
  return raster;
};

describe('assertPixelBudget', () => {
  test('a normal photograph passes', () => {
    expect(() => assertPixelBudget(6000, 4000, 'jpeg')).not.toThrow();
  });

  test('the ceiling itself passes — it is inclusive', () => {
    expect(() => assertPixelBudget(MAX_IMAGE_PIXELS, 1, 'png')).not.toThrow();
  });

  test('one pixel over the ceiling is refused, with the arithmetic in the cause', () => {
    const failure = thrown(() => assertPixelBudget(MAX_IMAGE_PIXELS + 1, 1, 'png'));
    expect(failure.code).toBe('X_IMAGE_TOO_LARGE');
    expect(failure.cause).toContain(String(MAX_IMAGE_PIXELS));
    expect(failure.meta).toMatchObject({ pixels: MAX_IMAGE_PIXELS + 1, ceiling: MAX_IMAGE_PIXELS });
  });

  test('the source is named so the caller knows which header lied', () => {
    expect(thrown(() => assertPixelBudget(1e6, 1e6, 'webp VP8X')).cause).toContain('webp VP8X');
  });

  test.each([
    ['zero', 0, 10],
    ['negative', -4, 10],
    ['fractional', 10.5, 10],
    ['NaN', Number.NaN, 10],
    ['Infinity', Number.POSITIVE_INFINITY, 10],
  ])('a %s dimension is not a size', (_label, width, height) => {
    // A header that declares no size is INCONSISTENT bytes, not too many of them: it answered
    // X_IMAGE_TOO_LARGE, whose fix is to downscale an image that has no pixels to scale.
    const failure = thrown(() => assertPixelBudget(width, height, 'png'));
    expect(failure.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(failure.cause).toContain('not a size');
  });
});

describe('blankRaster', () => {
  test('allocates exactly width * height * 4 bytes', () => {
    expect(blankRaster(7, 3).pixels.length).toBe(7 * 3 * 4);
  });

  test('starts fully transparent — an unfilled canvas must not read as black', () => {
    expect([...blankRaster(2, 1).pixels]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('refuses a bomb before it allocates a single byte', () => {
    expect(thrown(() => blankRaster(40_000, 40_000)).code).toBe('X_IMAGE_TOO_LARGE');
  });

  test('carries the caller-supplied source label into the error', () => {
    expect(thrown(() => blankRaster(0, 0, 'icon canvas')).cause).toContain('icon canvas');
  });

  test('pixels are clamped, not wrapped — 300 stays 255 and -20 stays 0', () => {
    const raster = blankRaster(1, 1);
    raster.pixels[0] = 300;
    raster.pixels[1] = -20;
    expect([raster.pixels[0], raster.pixels[1]]).toEqual([255, 0]);
  });
});

describe('rasterFrom', () => {
  test('wraps a correctly sized buffer without copying it', () => {
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    const raster = rasterFrom(2, 2, pixels);
    expect(raster.pixels).toBe(pixels);
  });

  // A short buffer and a long one are both inconsistent bytes, not a bomb: the pixel count already
  // passed the ceiling one line earlier, so the only thing left to report is a failed decode.
  test('a buffer that disagrees with the declared size is a decode failure, both ways', () => {
    expect(thrown(() => rasterFrom(2, 2, new Uint8ClampedArray(15))).code).toBe(
      'X_IMAGE_DECODE_FAILED',
    );
    expect(thrown(() => rasterFrom(2, 2, new Uint8ClampedArray(17))).code).toBe(
      'X_IMAGE_DECODE_FAILED',
    );
    expect(thrown(() => rasterFrom(2, 2, new Uint8ClampedArray(17))).cause).toContain('needs 16');
  });

  test('the size is budget-checked before the length is even compared', () => {
    expect(thrown(() => rasterFrom(-1, 4, new Uint8ClampedArray(0))).cause).toContain('not a size');
  });
});

describe('hasAlpha', () => {
  test('a fully opaque raster has none', () => {
    expect(hasAlpha(opaque(4, 4))).toBe(false);
  });

  test('a fresh canvas is entirely transparent, so it has alpha', () => {
    expect(hasAlpha(blankRaster(4, 4))).toBe(true);
  });

  test('one partially transparent pixel anywhere is enough', () => {
    const raster = opaque(8, 8);
    raster.pixels[raster.pixels.length - 1] = 254;
    expect(hasAlpha(raster)).toBe(true);
  });

  test('reads the alpha channel only — dark pixels are not transparent ones', () => {
    const raster = opaque(2, 2);
    raster.pixels.fill(0, 0, 3);
    expect(hasAlpha(raster)).toBe(false);
  });
});

describe('cropRaster', () => {
  test('copies exactly the region, row by row', () => {
    const raster = blankRaster(3, 3, 'test');
    for (let i = 0; i < 9; i += 1) raster.pixels[i * 4] = i;
    const out = cropRaster(raster, { x: 1, y: 1, width: 2, height: 2 });
    expect([out.width, out.height]).toEqual([2, 2]);
    expect([0, 1, 2, 3].map((i) => out.pixels[i * 4])).toEqual([4, 5, 7, 8]);
  });

  test('a region outside the raster is inconsistent geometry, refused by code', () => {
    const raster = blankRaster(2, 2, 'test');
    expect(() => cropRaster(raster, { x: 1, y: 0, width: 2, height: 1 })).toThrow(
      ImageDecodeFailedError,
    );
  });
});
