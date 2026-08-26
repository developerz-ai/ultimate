// Why: `@ultimat3/seo` inlines the width/height this module promises, so a variant whose bytes
// disagree with `variantKey()` or `fitDimensions()` is the layout shift the whole path exists to
// prevent — and an unsupported format must surface core's own code, never a second one.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createRaster,
  decodeImage,
  encodeImage,
  hasAlpha,
  IMAGE_FORMATS,
  isUltimateError,
  probeImage,
} from '@ultimat3/core';
import {
  blurPlaceholder,
  DEFAULT_QUALITY,
  DEFAULT_SRCSET_WIDTHS,
  fitDimensions,
  type ImageTransform,
  isVariantFormat,
  srcsetDescriptors,
  transformImage,
  VARIANT_FORMATS,
  variantKey,
} from './image';
import { resetStorage } from './storage';

/**
 * The caller the guard exists for: a query string, a JS consumer, an `as` that was already wrong.
 * Before 9.0.0 this needed no cast at all — storage's own `ImageFormat` was a four-member set, so
 * a caller could narrow a `probeImage()` value on it and be told `gif` could not occur.
 */
const untypedTransform = (format: string): ImageTransform => ({ format }) as ImageTransform;

/** 40x20 and opaque: wide enough that `cover` and `contain` disagree about the box. */
function opaquePng(): Uint8Array {
  const raster = createRaster(40, 20);
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

/** 8x8, left half fully transparent — the alpha a JPEG cannot carry. */
function alphaPng(): Uint8Array {
  const raster = createRaster(8, 8);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const at = (y * 8 + x) * 4;
      raster.pixels[at] = 255;
      raster.pixels[at + 3] = x < 4 ? 0 : 255;
    }
  }
  return encodeImage(raster, 'png');
}

const dataUrlBytes = (uri: string): Uint8Array =>
  Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1)), (char) => char.charCodeAt(0));

/** PNG bytes only — `decodeImage` is core's raw-pixel seam, not a second decoder. */
const alphaAt = (bytes: Uint8Array, x: number, y: number): number => {
  const raster = decodeImage(bytes);
  return raster.pixels[(y * raster.width + x) * 4 + 3] ?? -1;
};

// Registered disks are module-level state; a leaked one would make these cases order-dependent.
beforeEach(() => {
  resetStorage();
});

describe('variantKey', () => {
  test('derives the key from the source key and the transform, webp by default', () => {
    expect(variantKey('photos/hero.png', {})).toBe('photos/hero@full.webp');
    expect(variantKey('photos/hero.png', { width: 640 })).toBe('photos/hero@w640.webp');
    expect(variantKey('photos/hero.png', { width: 640, height: 480, fit: 'cover' })).toBe(
      'photos/hero@w640-h480-cover.webp',
    );
  });

  test('spells the extension per format, jpeg as jpg', () => {
    const extensions = VARIANT_FORMATS.map((format) => variantKey('a/b.tiff', { format }));
    expect(extensions).toEqual(['a/b@full.avif', 'a/b@full.webp', 'a/b@full.jpg', 'a/b@full.png']);
  });

  test('names the quality only when it is not the default', () => {
    expect(variantKey('a.png', { width: 10, quality: DEFAULT_QUALITY })).toBe('a@w10.webp');
    expect(variantKey('a.png', { width: 10, quality: 55 })).toBe('a@w10-q55.webp');
  });

  test('is deterministic — the same transform is the same cache key', () => {
    const transform: ImageTransform = { width: 320, height: 200, fit: 'contain', quality: 42 };
    expect(variantKey('x/y.jpg', transform)).toBe(variantKey('x/y.jpg', transform));
  });

  test('refuses a key that escapes its prefix', () => {
    expect(() => variantKey('../etc/passwd.png', { width: 10 })).toThrow(/X_STORAGE_PATH_UNSAFE/);
  });
});

describe('srcsetDescriptors', () => {
  test('emits the default widths as `<n>w` descriptors', () => {
    const descriptors = srcsetDescriptors('photos/hero.png');
    expect(descriptors.map((d) => d.descriptor)).toEqual(
      DEFAULT_SRCSET_WIDTHS.map((width) => `${width}w`),
    );
    expect(descriptors[0]?.key).toBe('photos/hero@w320.webp');
  });

  test('drops widths above the intrinsic width — upscaling is never useful', () => {
    const descriptors = srcsetDescriptors('photos/hero.png', {
      intrinsic: { width: 1000, height: 500 },
    });
    expect(descriptors.map((d) => d.width)).toEqual([320, 640, 960]);
  });

  test('threads format and quality into every key', () => {
    const descriptors = srcsetDescriptors('a.png', {
      widths: [100, 0, -5],
      format: 'jpeg',
      quality: 60,
    });
    expect(descriptors.map((d) => d.key)).toEqual(['a@w100-q60.jpg']);
  });
});

describe('fitDimensions', () => {
  const source = { width: 40, height: 20 };

  test('an empty transform is the source size', () => {
    expect(fitDimensions(source, {})).toEqual(source);
  });

  test('a single axis clamps to the source and keeps the ratio', () => {
    expect(fitDimensions(source, { width: 10 })).toEqual({ width: 10, height: 5 });
    expect(fitDimensions(source, { height: 10 })).toEqual({ width: 20, height: 10 });
    expect(fitDimensions(source, { width: 4000 })).toEqual(source);
  });

  test('cover is the exact box; contain scales until both sides fit', () => {
    expect(fitDimensions(source, { width: 10, height: 10, fit: 'cover' })).toEqual({
      width: 10,
      height: 10,
    });
    expect(fitDimensions(source, { width: 10, height: 10, fit: 'contain' })).toEqual({
      width: 10,
      height: 5,
    });
  });
});

describe('transformImage', () => {
  test('round-trips a real jpeg at the requested width', async () => {
    const bytes = await transformImage(opaquePng(), { width: 20, format: 'jpeg' });
    expect(probeImage(bytes)).toEqual({
      format: 'jpeg',
      width: 20,
      height: 10,
      mimeType: 'image/jpeg',
    });
  });

  test('round-trips a png and keeps its alpha', async () => {
    const bytes = await transformImage(alphaPng(), { width: 4, format: 'png' });
    expect(probeImage(bytes)).toMatchObject({ format: 'png', width: 4, height: 4 });
    expect(hasAlpha(decodeImage(bytes))).toBe(true);
    expect(alphaAt(bytes, 0, 0)).toBe(0);
    expect(alphaAt(bytes, 3, 0)).toBe(255);
  });

  test('jpeg drops the alpha png keeps — the reason png is encodable at all', async () => {
    // Read back through PNG, because the raw-pixel seam decodes PNG and the JPEG is the subject.
    const jpeg = await transformImage(alphaPng(), { width: 4, format: 'jpeg' });
    const asPng = await transformImage(jpeg, { width: 4, format: 'png' });
    expect(hasAlpha(decodeImage(asPng))).toBe(false);
  });

  test('never upscales past the source', async () => {
    const bytes = await transformImage(opaquePng(), { width: 4000, format: 'png' });
    expect(probeImage(bytes)).toMatchObject({ width: 40, height: 20 });
  });

  test('the encoded size is exactly what fitDimensions predicted, cover and contain', async () => {
    const source = { width: 40, height: 20 };
    for (const fit of ['cover', 'contain'] as const) {
      const transform: ImageTransform = { width: 10, height: 10, fit, format: 'png' };
      const bytes = await transformImage(opaquePng(), transform);
      expect(probeImage(bytes)).toMatchObject(fitDimensions(source, transform));
    }
  });

  test('webp is a real output now — one encoder, three formats', async () => {
    const bytes = await transformImage(opaquePng(), { width: 10, format: 'webp' });
    expect(probeImage(bytes)).toMatchObject({ format: 'webp', width: 10, height: 5 });
  });

  test('the default format is webp, which is also the default key extension', async () => {
    // These two must agree: `variantKey` writes `.webp` with no format asked for, so bytes in any
    // other format would be served under a key that names one the browser will not read.
    expect(variantKey('a/b.png', { width: 10 }).endsWith('.webp')).toBe(true);
    expect(probeImage(await transformImage(opaquePng(), { width: 10 })).format).toBe('webp');
  });

  test('rejects avif — it needs an OS codec the portable backend never uses', async () => {
    // A rejection, not a synchronous throw: this line would blow up before `expect` if the
    // function still threw out of a Promise-typed body.
    const pending = transformImage(opaquePng(), { width: 10, format: 'avif' });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toMatchObject({ code: 'X_IMAGE_UNSUPPORTED' });
    // `Promise.catch` widens the value to `Uint8Array | <handler result>`, so the rejection has to
    // be narrowed back before its `fix:` can be read — and a non-`UltimateError` rejection fails
    // both assertions rather than skipping them.
    const rejection: unknown = await pending.catch((reason: unknown) => reason);
    const fix = isUltimateError(rejection) ? rejection.fix : '';
    expect(fix).toContain('png');
    expect(fix).toContain('webp');
  });

  test('rejects bytes that are no image at all', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const pending = transformImage(garbage, { width: 10, format: 'png' });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toMatchObject({ code: 'X_IMAGE_UNSUPPORTED' });
  });

  test('rejects a truncated image as a decode failure, not as garbage', async () => {
    const truncated = opaquePng().slice(0, 12);
    await expect(transformImage(truncated, { format: 'png' })).rejects.toMatchObject({
      code: 'X_IMAGE_DECODE_FAILED',
    });
  });
});

describe('blurPlaceholder', () => {
  test('is a png data URI at most 32px on its long edge, at the source aspect ratio', async () => {
    const uri = await blurPlaceholder(opaquePng());
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    const info = probeImage(dataUrlBytes(uri));
    expect(info.format).toBe('png');
    expect(info.width).toBeLessThanOrEqual(32);
    // 40x20 source: landscape stays landscape. ThumbHash quantises the ratio (32x18 here, not
    // 32x16), which costs nothing because `@ultimat3/seo` paints this as `background-size:cover`
    // inside a box already sized from the real width/height — the LQIP never sets the box.
    expect(info.width).toBeGreaterThan(info.height);
  });

  test('stays small enough to inline in the document head', async () => {
    const uri = await blurPlaceholder(opaquePng());
    expect(uri.length).toBeLessThan(2048);
  });

  test('rejects bytes it cannot decode', async () => {
    const pending = blurPlaceholder(new TextEncoder().encode('not an image'));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toMatchObject({ code: 'X_IMAGE_UNSUPPORTED' });
  });
});

describe('the variant vocabulary against the one core probes', () => {
  /**
   * The smallest bytes `probeImage` calls a GIF: the signature plus the logical screen size. It
   * never has to decode — what is under test is the format NAME core answers with, not pixels.
   */
  const GIF_HEADER = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 2, 0, 0, 0, 0]);
  const SVG_DOC = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"></svg>',
  );

  test('every format a variant can be minted in is one core can probe', () => {
    const probeable: readonly string[] = IMAGE_FORMATS;
    for (const format of VARIANT_FORMATS) expect(probeable).toContain(format);
  });

  test('a format core probes and no variant can carry is refused, never keyed', () => {
    for (const bytes of [GIF_HEADER, SVG_DOC]) {
      const { format } = probeImage(bytes);
      expect(isVariantFormat(format)).toBe(false);
      expect(() => variantKey('photos/hero.png', untypedTransform(format))).toThrow(
        /X_IMAGE_UNSUPPORTED/,
      );
    }
  });
});

describe('the barrel', () => {
  test('re-exports neither of core`s image vocabulary names — one name, one set', async () => {
    const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // Line comments stripped: the rule is about what the package EXPORTS, and the comment beside
    // the image block names both absent identifiers on purpose. `\b` so `ImageFit`, `ImageSize`,
    // `ImageTransform` and `IMAGE_CONTENT_TYPES` stay legal and `VariantFormat` is not a match.
    const exported = source.replace(/^\s*\/\/.*$/gm, '');
    expect(exported).not.toMatch(/\bImageFormat\b/);
    expect(exported).not.toMatch(/\bIMAGE_FORMATS\b/);
  });
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
    expect(variantKey('a.png', { width: 10, quality: 55 })).toBe('a@w10-q55.webp');
    expect(variantKey('a.png', { width: 10, quality: DEFAULT_QUALITY })).toBe('a@w10.webp');
  });
});
