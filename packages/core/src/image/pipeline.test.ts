// Single responsibility: proves the ONE entry point's contract — that the published capability
// lists are the truth, that a transform lands on the box it promised, and that the same bytes and
// spec produce the same OUTPUT BYTES. The last one is not a nicety: `variantKey` is content-
// addressed, so a re-encode that differed per run or per platform is a cache that never hits.

import { describe, expect, test } from 'bun:test';
import { ImageDecodeFailedError, ImageTooLargeError, ImageUnsupportedError } from './errors';
import {
  AVIF_12X16,
  fixtureBytes,
  GIF_5X7,
  gradientPixel,
  type ImageFixture,
  JPEG_420_16X16,
  JPEG_420_ODD_33X17,
  JPEG_444_16X16,
  jpegPixel,
  oddJpegPixel,
  PNG_GRADIENT_32X24,
  PNG_GRAY_2X2,
  PNG_GRAY_ALPHA_2X2,
  PNG_GRAY16_2X2,
  PNG_PALETTE_4X1,
  PNG_RGB_3X2,
  PNG_RGBA_4X4,
  SVG_120X45,
  WEBP_9X11,
} from './fixtures';
import {
  blurDataUrl,
  canDecode,
  canEncode,
  DECODABLE_FORMATS,
  dataUrl,
  ENCODABLE_FORMATS,
  transformImageBytes,
} from './pipeline';
import { crc32, writeU32 } from './png-bytes';
import { decodeImage, encodeImage } from './png-pixels';
import { IMAGE_FORMATS, probeImage } from './probe';
import { createRaster, MAX_IMAGE_PIXELS, type Raster } from './raster';

interface Failure {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
}

const thrown = async (run: () => Promise<unknown>): Promise<Failure> => {
  try {
    await run();
    return { code: 'no-throw', cause: '', fix: '' };
  } catch (error) {
    if (
      error instanceof ImageUnsupportedError ||
      error instanceof ImageDecodeFailedError ||
      error instanceof ImageTooLargeError
    ) {
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

type Formula = (x: number, y: number) => readonly [number, number, number];

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/** Mean absolute luma error against the formula the fixture's encoder was fed. */
function lumaError(raster: Raster, formula: Formula): number {
  let sum = 0;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const o = (y * raster.width + x) * 4;
      const want = formula(x, y);
      sum += Math.abs(
        luma(raster.pixels[o] ?? 0, raster.pixels[o + 1] ?? 0, raster.pixels[o + 2] ?? 0) -
          luma(want[0], want[1], want[2]),
      );
    }
  }
  return sum / (raster.width * raster.height);
}

const bytesOfDataUrl = (uri: string): Uint8Array => {
  const base64 = uri.slice(uri.indexOf(',') + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

/** A real PNG whose IHDR claims more pixels than the ceiling, CRC repaired so it parses. */
const bombHeader = (): Uint8Array => {
  const bytes = Uint8Array.from(encodeImage(solid(2, 2, 255)));
  writeU32(bytes, 16, 0xffff);
  writeU32(bytes, 20, 0xffff);
  writeU32(bytes, 29, crc32(bytes, 12, 29));
  return bytes;
};

describe('capability lists', () => {
  test('every format the pipeline claims to handle is a format it can identify', () => {
    const known: readonly string[] = IMAGE_FORMATS;
    expect([...DECODABLE_FORMATS, ...ENCODABLE_FORMATS].every((f) => known.includes(f))).toBe(true);
  });

  test('canDecode and canEncode answer for the whole union, not just the encodable half', () => {
    expect(IMAGE_FORMATS.filter(canDecode)).toEqual([...DECODABLE_FORMATS]);
    expect(IMAGE_FORMATS.filter(canEncode)).toEqual([...ENCODABLE_FORMATS]);
  });

  test('webp joined the encodable list; avif and svg did not, and the list must say so', () => {
    expect(canEncode('webp')).toBe(true);
    // AVIF needs an OS codec the portable backend never uses, so it is refused on EVERY platform
    // rather than working on a laptop and failing on the node that serves the variant.
    expect(canEncode('avif')).toBe(false);
    expect(canEncode('svg')).toBe(false);
    expect(canDecode('svg')).toBe(false);
  });
});

describe('decoding, against an independent encoder', () => {
  // Pillow and ffmpeg wrote these bytes and the expected pixels; the pipeline agreeing with them
  // is what makes "the codec changed" a failure rather than a mutually agreed hallucination.
  test.each([
    ['truecolour + alpha', PNG_RGBA_4X4],
    ['greyscale', PNG_GRAY_2X2],
    ['greyscale + alpha', PNG_GRAY_ALPHA_2X2],
    ['16 bits per channel', PNG_GRAY16_2X2],
    ['indexed colour with tRNS', PNG_PALETTE_4X1],
  ])('decodes %s to the reference pixels', async (_label, fixture: ImageFixture) => {
    const out = await transformImageBytes(fixtureBytes(fixture), { format: 'png' });
    expect([...decodeImage(out).pixels]).toEqual([...(fixture.pixels ?? [])]);
  });

  test.each([
    ['webp', WEBP_9X11],
    ['gif', GIF_5X7],
  ])('%s is decodable now — it was probe-only before Bun.Image', async (_label, fixture) => {
    const out = await transformImageBytes(fixtureBytes(fixture), { format: 'png' });
    expect(probeImage(out)).toMatchObject({
      format: 'png',
      width: fixture.width,
      height: fixture.height,
    });
  });

  test('a filtered PNG decodes to the formula its reference encoder was fed', async () => {
    // PNG_GRADIENT_32X24 is big enough that Pillow picked a different row filter per scanline.
    const raster = decodeImage(
      await transformImageBytes(fixtureBytes(PNG_GRADIENT_32X24), { format: 'png' }),
    );
    for (const [x, y] of [
      [0, 0],
      [31, 23],
      [17, 9],
    ] as const) {
      const at = (y * 32 + x) * 4;
      expect([...raster.pixels.slice(at, at + 4)]).toEqual([...gradientPixel(x, y), 255]);
    }
  });

  test.each([
    ['4:4:4', JPEG_444_16X16, jpegPixel, 5],
    ['4:2:0', JPEG_420_16X16, jpegPixel, 5],
    ['4:2:0 with odd dimensions', JPEG_420_ODD_33X17, oddJpegPixel, 8],
  ])(
    'a %s JPEG decodes to within a lossy tolerance of the reference formula',
    async (_label, fixture: ImageFixture, formula: Formula, tolerance) => {
      const raster = decodeImage(
        await transformImageBytes(fixtureBytes(fixture), { format: 'png' }),
      );
      // Mean luma error, not a per-pixel channel max: chroma is quantised hard at 4:2:0 and a
      // single-pixel bound would only be satisfiable by a tolerance that asserts nothing.
      expect([raster.width, raster.height]).toEqual([fixture.width, fixture.height]);
      expect(lumaError(raster, formula)).toBeLessThan(tolerance);
      // The odd case pads to whole MCUs and the padding must be CROPPED, not returned. Scoring a
      // SHIFTED reference is what makes alignment observable at all: a decode off by two columns
      // would score the shifted formula BETTER, and the strict ordering below is the other way.
      expect(lumaError(raster, (x, y) => formula(x + 2, y))).toBeGreaterThan(
        lumaError(raster, formula),
      );
    },
  );

  test('bytes matching no format at all are refused with a runnable way forward', async () => {
    const failure = await thrown(() => transformImageBytes(new Uint8Array(32).fill(3)));
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(failure.fix).toContain('file <path>');
  });

  test('SVG is markup, not pixels — it is measured by probeImage and refused here', async () => {
    expect(probeImage(fixtureBytes(SVG_120X45))).toMatchObject({ width: 120, height: 45 });
    expect((await thrown(() => transformImageBytes(fixtureBytes(SVG_120X45)))).code).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
  });

  test('a truncated PNG is a decode failure, not a black image', async () => {
    const truncated = fixtureBytes(PNG_GRADIENT_32X24).subarray(0, 30);
    expect((await thrown(() => transformImageBytes(truncated))).code).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('the decompression-bomb ceiling is refused from the header, before any allocation', async () => {
    const failure = await thrown(() => transformImageBytes(bombHeader()));
    expect(failure.code).toBe('X_IMAGE_TOO_LARGE');
    expect(failure.fix).toContain('MAX_IMAGE_PIXELS');
    expect(0xffff * 0xffff).toBeGreaterThan(MAX_IMAGE_PIXELS);
  });
});

describe('transformImageBytes', () => {
  test('resizes to the requested width and reports it back through the header', async () => {
    const out = await transformImageBytes(fixtureBytes(PNG_GRADIENT_32X24), {
      width: 16,
      format: 'jpeg',
    });
    expect(probeImage(out)).toMatchObject({ format: 'jpeg', width: 16, height: 12 });
  });

  test('never upscales: a width above the intrinsic one clamps to the source', async () => {
    const out = await transformImageBytes(fixtureBytes(PNG_RGB_3X2), { width: 800, format: 'png' });
    expect(probeImage(out)).toMatchObject({ width: 3, height: 2 });
  });

  test('with no spec at all it re-encodes at the source size, in the source format', async () => {
    expect(probeImage(await transformImageBytes(fixtureBytes(PNG_RGBA_4X4)))).toMatchObject({
      format: 'png',
      width: 4,
      height: 4,
    });
    expect(probeImage(await transformImageBytes(fixtureBytes(JPEG_444_16X16))).format).toBe('jpeg');
  });

  test('a source format the pipeline cannot WRITE falls back to PNG, never to a refusal', async () => {
    // GIF decodes and does not encode. Keeping the source format would refuse a legal transform.
    expect(probeImage(await transformImageBytes(fixtureBytes(GIF_5X7))).format).toBe('png');
  });

  test('webp is a real output now, at the size that was asked for', async () => {
    const out = await transformImageBytes(fixtureBytes(PNG_GRADIENT_32X24), {
      width: 8,
      format: 'webp',
    });
    expect(probeImage(out)).toMatchObject({ format: 'webp', width: 8, height: 6 });
  });

  test('quality is honoured — a lower number is fewer bytes', async () => {
    const bytes = encodeImage(noise(64, 64));
    const low = await transformImageBytes(bytes, { format: 'jpeg', quality: 20 });
    const high = await transformImageBytes(bytes, { format: 'jpeg', quality: 95 });
    expect(low.length).toBeLessThan(high.length);
  });

  test('padding and background reach the canvas', async () => {
    const out = await transformImageBytes(fixtureBytes(PNG_RGB_3X2), {
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

  test('a transparent padding survives the composite as real alpha, not as black', async () => {
    const out = await transformImageBytes(encodeImage(solid(8, 8, 255)), {
      width: 20,
      height: 20,
      padding: 0.25,
      format: 'png',
    });
    const raster = decodeImage(out);
    expect([...raster.pixels.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(raster.pixels[(10 * 20 + 10) * 4 + 3]).toBe(255);
  });

  test('the composite path is WRITTEN by libspng, not by the raw seam it transports through', async () => {
    const out = await transformImageBytes(encodeImage(solid(64, 64, 255)), {
      width: 64,
      height: 64,
      padding: 0.1,
      format: 'png',
    });
    // Same pixels through `png-pixels.ts` (filter 0) are strictly more bytes. Returning the
    // transport encoding would ship every PWA icon 1.2-1.8x larger than it needs to be.
    expect(out.length).toBeLessThan(encodeImage(decodeImage(out)).length);
  });

  test('backend is pinned to the static codecs, so the bytes do not depend on the OS', async () => {
    // Set on every call, never once at import: the property is process-global and writable, and
    // an app flipping it to 'system' would otherwise mint macOS-only bytes under a shared key.
    Bun.Image.backend = 'system';
    await transformImageBytes(fixtureBytes(PNG_RGB_3X2), { width: 2, format: 'png' });
    // Read through a call: after the assignment above, TS narrows the property to the literal
    // 'system' for the rest of the block — which is precisely the claim under test, so comparing
    // the narrowed reference would be a type error over a correct assertion.
    const backend = (): string => Bun.Image.backend;
    expect(backend()).toBe('bun');
  });

  test('a format the pipeline cannot write fails before the source is even decoded', async () => {
    const failure = await thrown(() =>
      transformImageBytes(fixtureBytes(PNG_RGB_3X2), { width: 2, format: 'avif' }),
    );
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(failure.cause).toContain('avif');
    // Bytes that cannot decode at all are what makes the early exit observable: reaching the
    // format refusal instead of X_IMAGE_DECODE_FAILED proves the spec was answered first, before
    // 64 megapixels were expanded and resampled for an encoder that was never going to run.
    const undecodable = await thrown(() =>
      transformImageBytes(fixtureBytes(PNG_GRADIENT_32X24).subarray(0, 30), { format: 'avif' }),
    );
    expect(undecodable.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(undecodable.cause).toContain('encoding avif');
    expect(undecodable.fix).toContain('ImageTransformDriver');
  });

  test.each([
    ['the fast path', { width: 12, format: 'jpeg', quality: 70 } as const],
    ['the composite path', { width: 12, height: 12, padding: 0.1, format: 'png' } as const],
  ])('is deterministic on %s — the same bytes and spec, the same output', async (_label, spec) => {
    const bytes = fixtureBytes(PNG_GRADIENT_32X24);
    const [first, second] = await Promise.all([
      transformImageBytes(bytes, spec),
      transformImageBytes(bytes, spec),
    ]);
    expect([...first]).toEqual([...second]);
  });

  test('the same source re-encoded twice hashes identically, which is what variantKey assumes', async () => {
    const bytes = fixtureBytes(JPEG_444_16X16);
    const spec = { width: 8, format: 'webp' } as const;
    const hash = async (): Promise<string> =>
      Bun.SHA256.hash(await transformImageBytes(bytes, spec), 'hex');
    expect(await hash()).toBe(await hash());
  });
});

describe('dataUrl', () => {
  test('carries the format mime type and round trips the bytes', () => {
    const bytes = encodeImage(solid(2, 2, 255));
    const uri = dataUrl(bytes, 'png');
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect([...bytesOfDataUrl(uri)]).toEqual([...bytes]);
  });

  test('an image larger than one chunk does not overflow the argument stack', () => {
    // The chunked base64 exists for exactly this: `String.fromCharCode(...bytes)` spread over a
    // whole photograph throws RangeError, and a photograph is the normal case. Noise, because a
    // flat colour deflates to a couple of kilobytes and would never reach the chunk boundary.
    const bytes = encodeImage(noise(400, 400));
    expect(bytes.length).toBeGreaterThan(0x8000);
    expect([...bytesOfDataUrl(dataUrl(bytes, 'png'))]).toEqual([...bytes]);
  });
});

describe('blurDataUrl', () => {
  test('is a PNG data URI at most 32px on its long edge', async () => {
    const uri = await blurDataUrl(fixtureBytes(PNG_GRADIENT_32X24));
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    const info = probeImage(bytesOfDataUrl(uri));
    expect(info.format).toBe('png');
    expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(32);
  });

  test('keeps the source aspect ratio, so the placeholder reserves the right box', async () => {
    const info = probeImage(bytesOfDataUrl(await blurDataUrl(encodeImage(solid(300, 900, 255)))));
    expect(info.height).toBeGreaterThan(info.width * 2);
  });

  test('is PNG even for a JPEG source — at this size the JPEG headers cost more than the pixels', async () => {
    const uri = await blurDataUrl(fixtureBytes(JPEG_444_16X16));
    expect(probeImage(bytesOfDataUrl(uri)).format).toBe('png');
  });

  test('stays small enough to inline in a document head', async () => {
    expect((await blurDataUrl(fixtureBytes(PNG_GRADIENT_32X24))).length).toBeLessThan(2048);
  });

  test('is deterministic — an LQIP inlined in HTML must not change the page hash per render', async () => {
    const bytes = fixtureBytes(PNG_GRADIENT_32X24);
    expect(await blurDataUrl(bytes)).toBe(await blurDataUrl(bytes));
  });

  test('an undecodable source rejects with a code, never a bare Error', async () => {
    expect((await thrown(() => blurDataUrl(fixtureBytes(AVIF_12X16)))).code).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
  });
});
