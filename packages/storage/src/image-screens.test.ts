// The screens on a variant: quality, an explicit null, source identity, box and upscale. Split out
// of `image.test.ts` at the file ceiling.

import { beforeEach, describe, expect, test } from 'bun:test';
import { blankRaster, encodeImage, isUltimateError } from '@ultimat3/core';
import {
  DEFAULT_QUALITY,
  fitDimensions,
  type ImageTransform,
  srcsetDescriptors,
  transformImage,
  variantKey,
} from './image';
import { resetStorage } from './storage';

/** 40x20 and opaque: wide enough that `cover` and `contain` disagree about the box. */
function opaquePng(): Uint8Array {
  const raster = blankRaster(40, 20);
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      const at = (y * 40 + x) * 4;
      raster.pixels[at] = x * 6;
      raster.pixels[at + 1] = y * 12;
      raster.pixels[at + 2] = 128;
      raster.pixels[at + 3] = 255;
    }
  }
  return encodeImage(raster, 'png');
}

// Registered disks are module-level state; a leaked one would make these cases order-dependent.
beforeEach(() => {
  resetStorage();
});

/**
 * Quality reaches TWO places and only one of them decodes: `transformImage` hands it to the
 * encoder, which CLAMPS silently (measured in core: `NaN` and `-5` both wrote the worst encoding
 * the codec can make, `Infinity` the best), while `variantKey` never reaches the encoder at all and
 * simply spells the number into the key — `qNaN`, or `q1000000000`, one distinct object per value
 * a caller can name.
 */
describe('the variant quality is screened against core, not beside it', () => {
  const codeOfSync = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return isUltimateError(error)
        ? `${error.code} ${error.cause}`
        : `unexpected: ${String(error)}`;
    }
    return 'no-error-thrown';
  };

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 101, 80.5])(
    'variantKey refuses quality %p rather than spelling it into a key',
    (quality) => {
      const rendered = codeOfSync(() => variantKey('a/b.png', { quality }));
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('quality');
    },
  );

  test('a real quality still mints the key it always did', () => {
    expect(variantKey('a.png', { width: 10, quality: 55 })).toBe('a.png@w10-q55.webp');
    expect(variantKey('a.png', { width: 10, quality: DEFAULT_QUALITY })).toBe('a.png@w10.webp');
  });
});

/**
 * `??` coalesces on `null` as well as `undefined`, so an explicit `null` — what a decoded JSON
 * config carries for a key someone blanked — took the default BEFORE the guard above could refuse
 * it. The mirror of the `NaN` half: one slips past the guard, the other past the default, and both
 * end in a bound nobody chose. `JSON.parse` rather than a literal, because `null` is not in the
 * option's type and this is the caller the bug is about.
 */
describe('an explicitly null quality is refused, never defaulted', () => {
  test('transformImage({ quality: null }) names quality', async () => {
    const fromJson: number = JSON.parse('null');
    let rendered = 'no-error-thrown';
    try {
      await transformImage(opaquePng(), { width: 4, format: 'jpeg', quality: fromJson });
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).toContain('X_INVARIANT');
    expect(rendered).toContain('quality');
  });

  test('variantKey({ quality: null }) names quality', () => {
    const fromJson: number = JSON.parse('null');
    let rendered = 'no-error-thrown';
    try {
      variantKey('a/b.png', { quality: fromJson });
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).toContain('X_INVARIANT');
    expect(rendered).toContain('quality');
  });
});

describe('two sources never share a variant', () => {
  // The stem was the key with its extension CUT, so `p/hero.png` and `p/hero.jpg` both minted
  // `p/hero@w100.webp` — whichever was requested first was served for the other, from cache.
  test('the source extension is part of the variant key', () => {
    const png = variantKey('p/hero.png', { width: 100 });
    const jpg = variantKey('p/hero.jpg', { width: 100 });
    expect(png).toBe('p/hero.png@w100.webp');
    expect(jpg).toBe('p/hero.jpg@w100.webp');
    expect(variantKey('p/hero', { width: 100 })).toBe('p/hero@w100.webp');
    expect(new Set([png, jpg, variantKey('p/hero', { width: 100 })]).size).toBe(3);
  });

  test('a variant of a variant is still its own key', () => {
    const once = variantKey('p/hero.png', { width: 100 });
    expect(variantKey(once, { width: 50 })).toBe('p/hero.png@w100.webp@w50.webp');
  });
});

describe('a variant box is screened where it is named', () => {
  const refusal = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return isUltimateError(error) ? error.code : `uncoded: ${String(error)}`;
    }
    return 'no-error-thrown';
  };

  // `{ width: NaN }` minted `a@wNaN.webp` — a writable key for bytes no encoder can produce, and
  // an unbounded spelling (`w1.5`, `w-3`, `wInfinity`) is an unbounded number of keys in a bucket.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 1.5]) {
    test(`width or height ${String(bad)} is refused by variantKey and fitDimensions`, () => {
      expect(refusal(() => variantKey('a.png', { width: bad }))).toBe('X_INVARIANT');
      expect(refusal(() => variantKey('a.png', { height: bad }))).toBe('X_INVARIANT');
      expect(refusal(() => fitDimensions({ width: 40, height: 20 }, { width: bad }))).toBe(
        'X_INVARIANT',
      );
      expect(refusal(() => fitDimensions({ width: 40, height: 20 }, { height: bad }))).toBe(
        'X_INVARIANT',
      );
    });
  }

  test('an explicit null is refused, never read as "no width"', () => {
    const blanked = { width: null } as unknown as ImageTransform;
    expect(refusal(() => variantKey('a.png', blanked))).toBe('X_INVARIANT');
  });

  test('srcsetDescriptors refuses a fractional width rather than minting w1.5', () => {
    expect(refusal(() => srcsetDescriptors('a.png', { widths: [1.5] }))).toBe('X_INVARIANT');
  });
});

describe('fitDimensions never answers a zero edge and never upscales', () => {
  test('an extreme ratio floors the derived edge at one pixel', () => {
    // 1000x1 at width 100 rounded the height to 0 — a box no encoder can fill.
    expect(fitDimensions({ width: 1000, height: 1 }, { width: 100 })).toEqual({
      width: 100,
      height: 1,
    });
    expect(fitDimensions({ width: 1, height: 1000 }, { height: 100 })).toEqual({
      width: 1,
      height: 100,
    });
    expect(
      fitDimensions({ width: 1000, height: 1 }, { width: 100, height: 100, fit: 'contain' }),
    ).toEqual({ width: 100, height: 1 });
  });

  test('contain with both edges stops at the source size, as a single edge already does', () => {
    const source = { width: 40, height: 20 };
    expect(fitDimensions(source, { width: 400, height: 400, fit: 'contain' })).toEqual(source);
    expect(fitDimensions(source, { width: 400, height: 400 })).toEqual(source);
    expect(fitDimensions(source, { width: 400, height: 10 })).toEqual({ width: 20, height: 10 });
  });
});
