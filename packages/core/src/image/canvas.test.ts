// Single responsibility: proves the half of a transform `Bun.Image` does not do — the box maths
// every caller reserves layout from, and the composite that letterboxes, pads and crops. Pure
// pixels and pure arithmetic, no codec: a wrong number here is a PWA icon with a clipped logo.

import { describe, expect, test } from 'bun:test';
import { composeOnto, fitBox, layOut, scaledToFit } from './canvas';
import { parseColor } from './color';
import { ImageUnsupportedError } from './errors';
import { createRaster, type Raster, rasterFrom } from './raster';

type Rgba = readonly [number, number, number, number];

const codeOf = (run: () => unknown): string => {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof ImageUnsupportedError ? error.code : `unexpected: ${String(error)}`;
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

describe('layOut', () => {
  const square = { width: 1024, height: 1024 };

  test('padding reserves a border and shrinks what the artwork is drawn at', () => {
    const layout = layOut(square, { width: 100, height: 100, padding: 0.1 });
    expect(layout.box).toEqual({ width: 100, height: 100 });
    expect(layout.pad).toBe(10);
    expect(layout.inner).toEqual({ width: 80, height: 80 });
    expect(layout.drawn).toEqual({ width: 80, height: 80 });
    expect(layout.needsCanvas).toBe(true);
  });

  test('a full-bleed box with no background needs no canvas — the resampler IS the answer', () => {
    expect(layOut(square, { width: 192, height: 192 }).needsCanvas).toBe(false);
    expect(layOut(square, { width: 192 }).needsCanvas).toBe(false);
    expect(layOut(square, {}).needsCanvas).toBe(false);
  });

  test('an OPAQUE background needs the canvas even at full bleed — alpha shows through it', () => {
    expect(layOut(square, { width: 8, height: 8, background: 'transparent' }).needsCanvas).toBe(
      false,
    );
    expect(layOut(square, { width: 8, height: 8, background: '#ff000000' }).needsCanvas).toBe(
      false,
    );
    expect(layOut(square, { width: 8, height: 8, background: '#ff0000' }).needsCanvas).toBe(true);
  });

  test('the colour is parsed even when the geometry would hide it', () => {
    // Otherwise a typo is refused for a 100x50 source and accepted for a 100x100 one.
    expect(codeOf(() => layOut(square, { width: 8, height: 8, background: 'chartreuse' }))).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
  });

  test('rejects a padding outside [0, 0.5)', () => {
    expect(codeOf(() => layOut(square, { width: 4, padding: 0.6 }))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => layOut(square, { width: 4, padding: -0.1 }))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => layOut(square, { width: 4, padding: 0.5 }))).toBe('X_IMAGE_UNSUPPORTED');
  });

  test('rejects a padding that leaves no room at the requested size', () => {
    expect(
      codeOf(() => layOut({ width: 4, height: 4 }, { width: 2, height: 2, padding: 0.4 })),
    ).toBe('X_IMAGE_UNSUPPORTED');
  });
});

describe('composeOnto', () => {
  test('contain letterboxes with exactly the background that was asked for', () => {
    const layout = layOut({ width: 4, height: 2 }, { width: 2, height: 4, background: '#0000ff' });
    expect(layout.drawn).toEqual({ width: 2, height: 1 });
    expect(parseColor('#0000ff')).toEqual(BLUE);
    const out = composeOnto(solid(2, 1, RED), layout);
    expect(at(out, 0, 0)).toEqual(BLUE);
    expect(at(out, 1, 1)).toEqual(BLUE);
    expect(at(out, 0, 2)).toEqual(RED);
    expect(at(out, 1, 2)).toEqual(RED);
    expect(at(out, 0, 3)).toEqual(BLUE);
  });

  test('cover centre-crops: the drawn artwork overflows and the edges are clipped away', () => {
    const layout = layOut({ width: 4, height: 2 }, { width: 2, height: 2, fit: 'cover' });
    expect(layout.drawn).toEqual({ width: 4, height: 2 });
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
    const out = composeOnto(stripes, layout);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(at(out, 0, 0)[0]).toBe(20);
    expect(at(out, 1, 0)[0]).toBe(30);
    expect(at(out, 0, 1)[0]).toBe(20);
    expect(at(out, 1, 1)[0]).toBe(30);
  });

  test('padding leaves an empty border and centres the artwork in what is left', () => {
    const layout = layOut({ width: 100, height: 100 }, { width: 100, height: 100, padding: 0.1 });
    const out = composeOnto(solid(80, 80, RED), layout);
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

  test('an opaque background makes every output pixel opaque, and lightens what is over it', () => {
    const halfRed: Rgba = [255, 0, 0, 128];
    const layout = layOut({ width: 4, height: 4 }, { width: 8, height: 4, background: '#ffffff' });
    const out = composeOnto(solid(layout.drawn.width, layout.drawn.height, halfRed), layout);
    for (let i = 3; i < out.pixels.length; i += 4) expect(out.pixels[i]).toBe(255);
    // Half-transparent red over white lightens toward pink, it does not stay pure red.
    const [r, g, b] = at(out, 4, 2);
    expect(r).toBe(255);
    expect(g).toBeGreaterThan(100);
    expect(b).toBeGreaterThan(100);
  });

  test('a transparent background preserves the source alpha untouched', () => {
    const halfRed: Rgba = [255, 0, 0, 128];
    const layout = layOut({ width: 4, height: 4 }, { width: 2, height: 2, padding: 0 });
    const out = composeOnto(solid(2, 2, halfRed), layout);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) expect(at(out, x, y)).toEqual(halfRed);
    }
  });

  test('a fully transparent background leaves the letterbox at zero, colour included', () => {
    // '#ff000000' and 'transparent' must not produce different bytes.
    const layout = layOut(
      { width: 4, height: 2 },
      { width: 2, height: 4, background: '#ff000000' },
    );
    const out = composeOnto(solid(2, 1, RED), layout);
    expect(at(out, 0, 0)).toEqual(CLEAR);
    expect(at(out, 0, 2)).toEqual(RED);
  });
});
