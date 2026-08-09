// Single responsibility: proves the one scaler's contract — box maths, colour parsing, and the
// resampling guarantees a PWA icon and an srcset variant both depend on (no drift, no halo).

import { describe, expect, test } from 'bun:test';
import { ImageUnsupportedError } from './errors';
import { createRaster, type Raster, rasterFrom } from './raster';
import { fitBox, parseColor, resizeRaster, scaledToFit } from './resize';

type Rgba = readonly [number, number, number, number];

const codeOf = (run: () => unknown): string => {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof ImageUnsupportedError ? error.code : `unexpected: ${String(error)}`;
  }
};

const fixOf = (run: () => unknown): string => {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof ImageUnsupportedError ? error.fix : `unexpected: ${String(error)}`;
  }
};

const solid = (width: number, height: number, color: Rgba): Raster => {
  const raster = createRaster(width, height, 'test');
  for (let i = 0; i < raster.pixels.length; i += 4) {
    raster.pixels[i] = color[0];
    raster.pixels[i + 1] = color[1];
    raster.pixels[i + 2] = color[2];
    raster.pixels[i + 3] = color[3];
  }
  return raster;
};

/** Builds a raster from `width * height` pixels in row-major order. */
const gridOf = (width: number, height: number, cells: readonly Rgba[]): Raster => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  cells.forEach((cell, index) => {
    pixels[index * 4] = cell[0];
    pixels[index * 4 + 1] = cell[1];
    pixels[index * 4 + 2] = cell[2];
    pixels[index * 4 + 3] = cell[3];
  });
  return rasterFrom(width, height, pixels);
};

const at = (raster: Raster, x: number, y: number): Rgba => {
  const i = (y * raster.width + x) * 4;
  const p = raster.pixels;
  return [p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0, p[i + 3] ?? 0];
};

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

describe('fitBox', () => {
  const source = { width: 400, height: 200 };

  test('keeps the source when neither axis is requested', () => {
    expect(fitBox(source, {})).toEqual({ width: 400, height: 200 });
  });

  test('derives the height from a width request', () => {
    expect(fitBox(source, { width: 100 })).toEqual({ width: 100, height: 50 });
  });

  test('derives the width from a height request', () => {
    expect(fitBox(source, { height: 50 })).toEqual({ width: 100, height: 50 });
  });

  test('never upscales on a single-axis request', () => {
    expect(fitBox(source, { width: 4000 })).toEqual({ width: 400, height: 200 });
    expect(fitBox(source, { height: 2000 })).toEqual({ width: 400, height: 200 });
  });

  test('returns exactly the box when both axes are given, upscale or not', () => {
    expect(fitBox(source, { width: 4000, height: 7 })).toEqual({ width: 4000, height: 7 });
  });

  test('never rounds a derived edge below one pixel', () => {
    expect(fitBox({ width: 1000, height: 3 }, { width: 10 })).toEqual({ width: 10, height: 1 });
  });

  test('rejects a non-integer, zero or negative dimension, naming the field', () => {
    expect(codeOf(() => fitBox(source, { width: 10.5 }))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => fitBox(source, { width: 0 }))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => fitBox(source, { height: -4 }))).toBe('X_IMAGE_UNSUPPORTED');
    expect(() => fitBox(source, { height: -4 })).toThrow(/height/);
  });
});

describe('scaledToFit', () => {
  const source = { width: 400, height: 200 };

  test('cover fills the box, overflowing the short axis', () => {
    expect(scaledToFit(source, { width: 100, height: 100 }, 'cover')).toEqual({
      width: 200,
      height: 100,
    });
  });

  test('contain fits inside the box, leaving the long axis short', () => {
    expect(scaledToFit(source, { width: 100, height: 100 }, 'contain')).toEqual({
      width: 100,
      height: 50,
    });
  });

  test('upscales when the box is bigger — a 128px source asked for a 512px icon', () => {
    expect(
      scaledToFit({ width: 128, height: 128 }, { width: 512, height: 512 }, 'contain'),
    ).toEqual({ width: 512, height: 512 });
  });

  test('never returns a zero edge', () => {
    expect(scaledToFit({ width: 1000, height: 2 }, { width: 4, height: 4 }, 'contain')).toEqual({
      width: 4,
      height: 1,
    });
  });
});

describe('parseColor', () => {
  test('transparent is the only name', () => {
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(codeOf(() => parseColor('red'))).toBe('X_IMAGE_UNSUPPORTED');
  });

  test('doubles the nibbles of the short forms', () => {
    expect(parseColor('#abc')).toEqual([0xaa, 0xbb, 0xcc, 255]);
    expect(parseColor('#abcd')).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  test('reads the long forms, defaulting alpha to opaque', () => {
    expect(parseColor('#aabbcc')).toEqual([0xaa, 0xbb, 0xcc, 255]);
    expect(parseColor('#aabbccdd')).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  test('is case insensitive', () => {
    expect(parseColor('#AABBCC')).toEqual(parseColor('#aabbcc'));
    expect(parseColor('#ABCD')).toEqual(parseColor('#abcd'));
    expect(parseColor('TRANSPARENT')).toEqual([0, 0, 0, 0]);
  });

  test('rejects a hex string of the wrong length', () => {
    expect(codeOf(() => parseColor('#12'))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => parseColor('#1234567'))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => parseColor('#gghhii'))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => parseColor(''))).toBe('X_IMAGE_UNSUPPORTED');
  });

  test('names every accepted form in the fix', () => {
    const fix = fixOf(() => parseColor('rebeccapurple'));
    for (const form of ['#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'transparent']) {
      expect(fix).toContain(form);
    }
  });
});

describe('resampling quality', () => {
  test('a solid image survives a downscale exactly — the area average must not drift', () => {
    const out = resizeRaster(solid(4, 4, RED), { width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) expect(at(out, x, y)).toEqual(RED);
    }
  });

  test('a black/white checkerboard averages to mid grey, not to one of its cells', () => {
    const out = resizeRaster(gridOf(2, 2, [BLACK, WHITE, WHITE, BLACK]), { width: 1, height: 1 });
    const [r, g, b, a] = at(out, 0, 0);
    expect(r).toBeGreaterThanOrEqual(127);
    expect(r).toBeLessThanOrEqual(128);
    expect(g).toBe(r);
    expect(b).toBe(r);
    expect(a).toBe(255);
  });

  test('upscaling is bilinear, not nearest — the interior takes intermediate values', () => {
    const out = resizeRaster(gridOf(2, 2, [BLACK, WHITE, BLACK, WHITE]), { width: 4, height: 4 });
    const row = [0, 1, 2, 3].map((x) => at(out, x, 0)[0]);
    expect(row[0]).toBe(0);
    expect(row[3]).toBe(255);
    // Nearest neighbour would give [0, 0, 255, 255]; bilinear must land strictly between.
    expect(row[1] ?? 0).toBeGreaterThan(0);
    expect(row[1] ?? 0).toBeLessThan(row[2] ?? 0);
    expect(row[2] ?? 0).toBeLessThan(255);
  });

  test('resamples in premultiplied alpha, so a transparent neighbour cannot darken the edge', () => {
    const transparentBlack: Rgba = [0, 0, 0, 0];
    const source = gridOf(2, 2, [RED, transparentBlack, transparentBlack, RED]);
    const [r, g, b, a] = at(resizeRaster(source, { width: 1, height: 1 }), 0, 0);
    // Averaging without premultiplying halves the red toward black: r would be ~128, not ~255.
    expect(r).toBeGreaterThan(240);
    expect(g).toBeLessThan(8);
    expect(b).toBeLessThan(8);
    expect(r).toBeGreaterThan(g + 200);
    expect(r).toBeGreaterThan(b + 200);
    expect(a).toBeGreaterThanOrEqual(127);
    expect(a).toBeLessThanOrEqual(128);
  });
});

describe('fit', () => {
  /** Four distinct columns, so a crop is visible in the output. */
  const stripes = gridOf(4, 2, [
    [10, 0, 0, 255],
    [20, 0, 0, 255],
    [30, 0, 0, 255],
    [40, 0, 0, 255],
    [10, 0, 0, 255],
    [20, 0, 0, 255],
    [30, 0, 0, 255],
    [40, 0, 0, 255],
  ]);

  test('cover centre-crops: the result comes from the middle columns', () => {
    const out = resizeRaster(stripes, { width: 2, height: 2, fit: 'cover' });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(at(out, 0, 0)[0]).toBe(20);
    expect(at(out, 1, 0)[0]).toBe(30);
    expect(at(out, 0, 1)[0]).toBe(20);
    expect(at(out, 1, 1)[0]).toBe(30);
  });

  test('contain letterboxes with exactly the background that was asked for', () => {
    const out = resizeRaster(solid(4, 2, RED), {
      width: 2,
      height: 4,
      fit: 'contain',
      background: '#0000ff',
    });
    expect(parseColor('#0000ff')).toEqual(BLUE);
    expect(at(out, 0, 0)).toEqual(BLUE);
    expect(at(out, 1, 1)).toEqual(BLUE);
    expect(at(out, 0, 2)).toEqual(RED);
    expect(at(out, 1, 2)).toEqual(RED);
    expect(at(out, 0, 3)).toEqual(BLUE);
  });

  test('contain is the default fit', () => {
    const boxed = resizeRaster(stripes, { width: 2, height: 4, background: '#0000ff' });
    const explicit = resizeRaster(stripes, {
      width: 2,
      height: 4,
      fit: 'contain',
      background: '#0000ff',
    });
    expect(Array.from(boxed.pixels)).toEqual(Array.from(explicit.pixels));
  });
});

describe('padding', () => {
  test('leaves an empty border and centres the artwork in what is left', () => {
    const out = resizeRaster(solid(100, 100, RED), { width: 100, height: 100, padding: 0.1 });
    expect(out.width).toBe(100);
    expect(out.height).toBe(100);
    for (let i = 0; i < 10; i += 1) {
      expect(at(out, i, i)).toEqual(CLEAR);
      expect(at(out, 99 - i, 99 - i)).toEqual(CLEAR);
      expect(at(out, i, 50)).toEqual(CLEAR);
      expect(at(out, 50, i)).toEqual(CLEAR);
    }
    expect(at(out, 10, 10)).toEqual(RED);
    expect(at(out, 89, 89)).toEqual(RED);
    expect(at(out, 50, 50)).toEqual(RED);
  });

  test('rejects a padding outside [0, 0.5)', () => {
    const source = solid(4, 4, RED);
    expect(codeOf(() => resizeRaster(source, { width: 4, padding: 0.6 }))).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
    expect(codeOf(() => resizeRaster(source, { width: 4, padding: -0.1 }))).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
    expect(codeOf(() => resizeRaster(source, { width: 4, padding: 0.5 }))).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
  });

  test('rejects a padding that leaves no room at the requested size', () => {
    expect(
      codeOf(() => resizeRaster(solid(4, 4, RED), { width: 2, height: 2, padding: 0.4 })),
    ).toBe('X_IMAGE_UNSUPPORTED');
  });
});

describe('compositing', () => {
  const halfRed: Rgba = [255, 0, 0, 128];

  test('an opaque background makes every output pixel opaque', () => {
    const out = resizeRaster(solid(4, 4, halfRed), {
      width: 8,
      height: 4,
      background: '#ffffff',
    });
    for (let i = 3; i < out.pixels.length; i += 4) expect(out.pixels[i]).toBe(255);
    // Half-transparent red over white lightens toward pink, it does not stay pure red.
    const [r, g, b] = at(out, 4, 2);
    expect(r).toBe(255);
    expect(g).toBeGreaterThan(100);
    expect(b).toBeGreaterThan(100);
  });

  test('a transparent background preserves the source alpha', () => {
    const out = resizeRaster(solid(4, 4, halfRed), {
      width: 2,
      height: 2,
      background: 'transparent',
    });
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) expect(at(out, x, y)).toEqual(halfRed);
    }
  });

  test('a fully transparent background leaves the letterbox at zero, colour included', () => {
    const out = resizeRaster(solid(4, 2, RED), { width: 2, height: 4, background: '#ff000000' });
    expect(at(out, 0, 0)).toEqual(CLEAR);
    expect(at(out, 0, 2)).toEqual(RED);
  });
});

describe('the fast path', () => {
  test('returns the identical object when nothing is asked for', () => {
    const source = solid(4, 4, RED);
    expect(resizeRaster(source, {})).toBe(source);
    expect(resizeRaster(source, { fit: 'cover' })).toBe(source);
    expect(resizeRaster(source, { padding: 0 })).toBe(source);
    expect(resizeRaster(source, { width: 4, height: 4 })).toBe(source);
  });

  test('does not take the fast path once a background is requested', () => {
    const source = solid(4, 4, RED);
    expect(resizeRaster(source, { background: 'transparent' })).not.toBe(source);
  });
});
