// Single responsibility: proves the ONE entry point's contract — that decode dispatches on the
// magic bytes, that the published capability lists are the truth, and that `transformImageBytes`
// is literally decode+resize+encode composed. The last one is what stops a second copy of the
// pipeline appearing in `storage`, `seo` or `pwa` the first time one of them needs a variant.

import { describe, expect, test } from 'bun:test';
import { ImageDecodeFailedError, ImageUnsupportedError } from './errors';
import {
  AVIF_12X16,
  fixtureBytes,
  GIF_5X7,
  JPEG_444_16X16,
  PNG_GRADIENT_32X24,
  PNG_RGB_3X2,
  PNG_RGBA_4X4,
  SVG_120X45,
  WEBP_9X11,
} from './fixtures';
import {
  BLUR_PLACEHOLDER_WIDTH,
  blurDataUrl,
  canDecode,
  canEncode,
  DECODABLE_FORMATS,
  dataUrl,
  decodeImage,
  defaultFormatFor,
  ENCODABLE_FORMATS,
  encodeImage,
  transformImageBytes,
} from './pipeline';
import { encodePng } from './png';
import { IMAGE_FORMATS, type ImageFormat, probeImage } from './probe';
import { createRaster, type Raster } from './raster';
import { resizeRaster } from './resize';

const thrown = (run: () => unknown): { code: string; cause: string; fix: string } => {
  try {
    run();
    return { code: 'no-throw', cause: 'no-throw', fix: 'no-throw' };
  } catch (error) {
    if (error instanceof ImageUnsupportedError || error instanceof ImageDecodeFailedError) {
      return { code: error.code, cause: error.cause, fix: error.fix };
    }
    return { code: `unexpected: ${String(error)}`, cause: '', fix: '' };
  }
};

const solid = (width: number, height: number, alpha: number): Raster => {
  const raster = createRaster(width, height, 'test');
  for (let i = 0; i < raster.pixels.length; i += 4) {
    raster.pixels[i] = 200;
    raster.pixels[i + 1] = 100;
    raster.pixels[i + 2] = 50;
    raster.pixels[i + 3] = alpha;
  }
  return raster;
};

/** Incompressible pixels from a fixed LCG — deterministic, unlike `Math.random`. */
const noise = (width: number, height: number): Raster => {
  const raster = createRaster(width, height, 'test');
  let seed = 0x2f6e2b1;
  for (let i = 0; i < raster.pixels.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raster.pixels[i] = (seed >>> 16) & 0xff;
  }
  return raster;
};

const bytesOfDataUrl = (uri: string): Uint8Array => {
  const base64 = uri.slice(uri.indexOf(',') + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

describe('capability lists', () => {
  test('every format the pipeline claims to handle is a format it can identify', () => {
    const known: readonly string[] = IMAGE_FORMATS;
    expect([...DECODABLE_FORMATS, ...ENCODABLE_FORMATS].every((f) => known.includes(f))).toBe(true);
  });

  test('canDecode and canEncode answer for the whole union, not just the built-in half', () => {
    const decodable = IMAGE_FORMATS.filter(canDecode);
    const encodable = IMAGE_FORMATS.filter(canEncode);
    expect(decodable).toEqual([...DECODABLE_FORMATS]);
    expect(encodable).toEqual([...ENCODABLE_FORMATS]);
  });

  test('webp and avif are probeable but never encodable — the list must say so', () => {
    expect(canEncode('webp')).toBe(false);
    expect(canEncode('avif')).toBe(false);
    expect(IMAGE_FORMATS.includes('webp')).toBe(true);
  });
});

describe('decodeImage', () => {
  test('dispatches on the magic bytes: PNG', () => {
    const raster = decodeImage(fixtureBytes(PNG_RGBA_4X4));
    expect([raster.width, raster.height]).toEqual([4, 4]);
    expect([...raster.pixels.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  test('dispatches on the magic bytes: JPEG', () => {
    const raster = decodeImage(fixtureBytes(JPEG_444_16X16));
    expect([raster.width, raster.height]).toEqual([16, 16]);
  });

  test.each([
    ['webp', WEBP_9X11],
    ['avif', AVIF_12X16],
    ['gif', GIF_5X7],
    ['svg', SVG_120X45],
  ])('%s is identified and then refused, never silently decoded', (format, fixture) => {
    const failure = thrown(() => decodeImage(fixtureBytes(fixture)));
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
    // Naming the format it recognised is the difference between "convert your AVIF" and a shrug.
    expect(failure.cause).toContain(format);
    expect(failure.fix).toContain('PNG or JPEG');
  });

  test('bytes matching no format at all name that, not a codec', () => {
    const failure = thrown(() => decodeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(failure.fix).toContain('ImageTransformDriver');
  });

  test('a truncated PNG is a decode failure, not a black image', () => {
    const truncated = fixtureBytes(PNG_GRADIENT_32X24).subarray(0, 30);
    expect(thrown(() => decodeImage(truncated)).code).toBe('X_IMAGE_DECODE_FAILED');
  });
});

describe('encodeImage', () => {
  test('PNG round trips exactly — it is the lossless half of the pipeline', () => {
    const source = decodeImage(fixtureBytes(PNG_RGBA_4X4));
    const decoded = decodeImage(encodeImage(source, 'png'));
    expect([...decoded.pixels]).toEqual([...source.pixels]);
  });

  test('JPEG produces a JPEG of the same size', () => {
    const source = decodeImage(fixtureBytes(PNG_GRADIENT_32X24));
    expect(probeImage(encodeImage(source, 'jpeg'))).toMatchObject({
      format: 'jpeg',
      width: 32,
      height: 24,
    });
  });

  test('quality is honoured — a lower number is fewer bytes', () => {
    const source = decodeImage(fixtureBytes(PNG_GRADIENT_32X24));
    expect(encodeImage(source, 'jpeg', 30).length).toBeLessThan(
      encodeImage(source, 'jpeg', 95).length,
    );
  });

  test('quality is ignored by PNG rather than changing the bytes', () => {
    const source = decodeImage(fixtureBytes(PNG_RGBA_4X4));
    expect([...encodeImage(source, 'png', 10)]).toEqual([...encodeImage(source, 'png', 90)]);
  });

  test.each(['webp', 'avif', 'gif', 'svg'] as const)(
    'encoding %s is refused with a fix that names the way out',
    (format: ImageFormat) => {
      const failure = thrown(() => encodeImage(solid(2, 2, 255), format));
      expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
      expect(failure.fix).toContain('ImageTransformDriver');
    },
  );
});

describe('defaultFormatFor', () => {
  test('a raster with any transparency stays PNG', () => {
    expect(defaultFormatFor(solid(2, 2, 128))).toBe('png');
  });

  test('a fully opaque raster becomes JPEG', () => {
    expect(defaultFormatFor(solid(2, 2, 255))).toBe('jpeg');
  });

  test('a single non-opaque pixel is enough — a logo never grows a black background', () => {
    const raster = solid(4, 4, 255);
    raster.pixels[15] = 254;
    expect(defaultFormatFor(raster)).toBe('png');
  });
});

describe('transformImageBytes', () => {
  test('is exactly decode + resize + encode, byte for byte', () => {
    const bytes = fixtureBytes(PNG_GRADIENT_32X24);
    const manual = encodePng(resizeRaster(decodeImage(bytes), { width: 8 }));
    expect([...transformImageBytes(bytes, { width: 8, format: 'png' })]).toEqual([...manual]);
  });

  test('resizes to the requested width and reports it back through the header', () => {
    const out = transformImageBytes(fixtureBytes(PNG_GRADIENT_32X24), {
      width: 16,
      format: 'jpeg',
    });
    expect(probeImage(out)).toMatchObject({ format: 'jpeg', width: 16, height: 12 });
  });

  test('never upscales: a width above the intrinsic one clamps to the source', () => {
    const out = transformImageBytes(fixtureBytes(PNG_RGB_3X2), { width: 800, format: 'png' });
    expect(probeImage(out)).toMatchObject({ width: 3, height: 2 });
  });

  test('with no spec at all it re-encodes at the source size in a source-derived format', () => {
    const out = transformImageBytes(fixtureBytes(PNG_RGBA_4X4));
    expect(probeImage(out)).toMatchObject({ format: 'png', width: 4, height: 4 });
  });

  test('an opaque source with no format asked for comes back as JPEG', () => {
    expect(probeImage(transformImageBytes(fixtureBytes(PNG_RGB_3X2))).format).toBe('jpeg');
  });

  test('the format decision is made on the RESIZED pixels, not the source', () => {
    // Resampling a hard alpha edge can only ever produce more partial alpha, never less, so a
    // source with transparency must still be PNG after the scaler has run.
    expect(probeImage(transformImageBytes(fixtureBytes(PNG_RGBA_4X4), { width: 2 })).format).toBe(
      'png',
    );
  });

  test('padding and background reach the scaler', () => {
    const out = transformImageBytes(fixtureBytes(PNG_RGB_3X2), {
      width: 10,
      height: 10,
      padding: 0.2,
      background: '#ff0000',
      format: 'png',
    });
    const raster = decodeImage(out);
    expect([raster.width, raster.height]).toEqual([10, 10]);
    expect([...raster.pixels.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  test('a format the pipeline cannot write fails before any work is wasted', () => {
    const failure = thrown(() =>
      transformImageBytes(fixtureBytes(PNG_RGB_3X2), { width: 2, format: 'webp' }),
    );
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
  });

  test('is deterministic — the same bytes and spec produce the same output', () => {
    const bytes = fixtureBytes(PNG_GRADIENT_32X24);
    const spec = { width: 12, format: 'jpeg', quality: 70 } as const;
    expect([...transformImageBytes(bytes, spec)]).toEqual([...transformImageBytes(bytes, spec)]);
  });
});

describe('dataUrl', () => {
  test('carries the format mime type and round trips the bytes', () => {
    const bytes = encodePng(solid(2, 2, 255));
    const uri = dataUrl(bytes, 'png');
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect([...bytesOfDataUrl(uri)]).toEqual([...bytes]);
  });

  test('an image larger than one chunk does not overflow the argument stack', () => {
    // The chunked base64 exists for exactly this: `String.fromCharCode(...bytes)` spread over a
    // whole photograph throws RangeError, and a photograph is the normal case. Noise, because a
    // flat colour deflates to a couple of kilobytes and would never reach the chunk boundary.
    const bytes = encodePng(noise(200, 200));
    expect(bytes.length).toBeGreaterThan(0x8000);
    expect([...bytesOfDataUrl(dataUrl(bytes, 'png'))]).toEqual([...bytes]);
  });
});

describe('blurDataUrl', () => {
  test('is a 16px-wide PNG data URI by default', () => {
    const uri = blurDataUrl(fixtureBytes(PNG_GRADIENT_32X24));
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect(probeImage(bytesOfDataUrl(uri))).toMatchObject({
      format: 'png',
      width: BLUR_PLACEHOLDER_WIDTH,
      height: 12,
    });
  });

  test('is PNG even for a JPEG source — at 16px the JPEG headers cost more than the pixels', () => {
    const uri = blurDataUrl(fixtureBytes(JPEG_444_16X16));
    expect(probeImage(bytesOfDataUrl(uri)).format).toBe('png');
  });

  test('honours an explicit width', () => {
    const uri = blurDataUrl(fixtureBytes(PNG_GRADIENT_32X24), 8);
    expect(probeImage(bytesOfDataUrl(uri))).toMatchObject({ width: 8, height: 6 });
  });

  test('keeps alpha, so the placeholder behind a logo is not a black square', () => {
    const raster = decodeImage(bytesOfDataUrl(blurDataUrl(fixtureBytes(PNG_RGBA_4X4), 4)));
    expect([...raster.pixels.slice(0, 16)].filter((_, i) => i % 4 === 3)).not.toEqual([
      255, 255, 255, 255,
    ]);
  });

  test('stays small enough to inline in a document head', () => {
    expect(blurDataUrl(fixtureBytes(PNG_GRADIENT_32X24)).length).toBeLessThan(2048);
  });
});
