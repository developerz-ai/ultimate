// Single responsibility: proves the raw-pixel seam is lossless in BOTH directions and against
// BOTH writers — ours (filter 0) and libspng's (adaptive filters 1 and 4). The composite path
// runs every PWA icon through here, so an unfilter bug is a logo that arrives as diagonal smear.

import { describe, expect, test } from 'bun:test';
import { ImageDecodeFailedError, ImageUnsupportedError } from './errors';
import { fixtureBytes, PNG_INTERLACED_8X8, PNG_PALETTE_4X1, PNG_RGBA_4X4 } from './fixtures';
import { decodeImage, encodeImage } from './png-pixels';
import { probeImage } from './probe';
import { createRaster, type Raster } from './raster';

const thrown = (run: () => unknown): { code: string; cause: string; fix: string } => {
  try {
    run();
    return { code: 'no-throw', cause: '', fix: '' };
  } catch (error) {
    if (error instanceof ImageUnsupportedError || error instanceof ImageDecodeFailedError) {
      return { code: error.code, cause: error.cause, fix: error.fix };
    }
    return { code: `unexpected: ${String(error)}`, cause: '', fix: '' };
  }
};

/** A gradient with partial alpha: every channel varies per pixel, so no filter can be a no-op. */
const gradient = (width: number, height: number): Raster => {
  const raster = createRaster(width, height, 'test');
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      raster.pixels[i] = (x * 7) % 256;
      raster.pixels[i + 1] = (y * 11) % 256;
      raster.pixels[i + 2] = (x * y) % 256;
      raster.pixels[i + 3] = (x + y) % 4 === 0 ? 0 : 255 - ((x + y) % 128);
    }
  }
  return raster;
};

describe('encodeImage', () => {
  test('writes a PNG the probe and Bun both read at the declared size', async () => {
    const bytes = encodeImage(gradient(13, 9));
    expect(probeImage(bytes)).toMatchObject({ format: 'png', width: 13, height: 9 });
    expect(await new Bun.Image(bytes).metadata()).toMatchObject({
      format: 'png',
      width: 13,
      height: 9,
    });
  });

  test('is deterministic — the same raster is the same bytes, which is what the cache keys on', () => {
    expect([...encodeImage(gradient(9, 7))]).toEqual([...encodeImage(gradient(9, 7))]);
  });

  test('refuses any format but PNG, naming the pipeline that writes the others', () => {
    // The raw seam has one writer on purpose; `transformImageBytes` is the one with three.
    const failure = thrown(() => encodeImage(gradient(2, 2), 'jpeg' as 'png'));
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(failure.fix).toContain('transformImageBytes');
  });
});

describe('decodeImage', () => {
  test('round trips our own writer exactly — PNG is the lossless half of the pipeline', () => {
    const source = gradient(17, 11);
    expect([...decodeImage(encodeImage(source)).pixels]).toEqual([...source.pixels]);
  });

  test("round trips libspng's writer, which picks a DIFFERENT filter per row", async () => {
    // The one assertion that exercises Sub/Up/Average/Paeth: our encoder only ever writes 0, so
    // a broken unfilter round-trips against itself and is invisible without Bun's bytes.
    const source = gradient(31, 23);
    const reEncoded = await new Bun.Image(encodeImage(source)).png().bytes();
    expect([...decodeImage(reEncoded).pixels]).toEqual([...source.pixels]);
  });

  test('reads a PNG written by an independent encoder, pixel for pixel', () => {
    const raster = decodeImage(fixtureBytes(PNG_RGBA_4X4));
    expect([raster.width, raster.height]).toEqual([4, 4]);
    expect([...raster.pixels]).toEqual([...(PNG_RGBA_4X4.pixels ?? [])]);
  });

  test.each([
    ['a palette PNG', PNG_PALETTE_4X1],
    ['an interlaced PNG', PNG_INTERLACED_8X8],
  ])('refuses %s and names the pipeline that reads it', (_label, fixture) => {
    const failure = thrown(() => decodeImage(fixtureBytes(fixture)));
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(failure.fix).toContain('transformImageBytes');
  });

  test('refuses bytes that are not a PNG at all', () => {
    const failure = thrown(() => decodeImage(new Uint8Array(64).fill(7)));
    expect(failure.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(failure.fix).toContain('transformImageBytes');
  });

  test('a truncated PNG is a decode failure, not a black image', () => {
    expect(thrown(() => decodeImage(encodeImage(gradient(16, 16)).subarray(0, 60))).code).toBe(
      'X_IMAGE_DECODE_FAILED',
    );
  });

  test('a PNG whose IDAT inflates to the wrong length is refused, never padded with zeros', () => {
    const bytes = encodeImage(gradient(8, 8));
    // Same pixels, a header claiming one row more: the inflated length no longer matches.
    const lying = Uint8Array.from(bytes);
    lying[23] = 9;
    const failure = thrown(() => decodeImage(lying));
    expect(failure.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(failure.cause).toContain('inflates to');
  });
});
