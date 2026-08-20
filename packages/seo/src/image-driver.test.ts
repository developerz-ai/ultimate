import { describe, expect, test } from 'bun:test';
import { createRaster, encodeImage, probeImage, type Raster } from '@ultimat3/core';
import { notImplementedDriver } from './errors';
import { builtinImageDriver, type TransformedImage } from './image-driver';
import { IMAGE_QUERY_KEYS, parseImageQuery } from './images';

/** A flat 64x48 PNG. `alpha: 255` is opaque; anything less makes the raster alpha-bearing. */
function pngSource(alpha: number): Uint8Array {
  const raster: Raster = createRaster(64, 48);
  for (let i = 0; i < raster.pixels.length; i += 4) {
    raster.pixels[i] = 200;
    raster.pixels[i + 1] = 120;
    raster.pixels[i + 2] = 40;
    raster.pixels[i + 3] = alpha;
  }
  return encodeImage(raster, 'png');
}

const OPAQUE = pngSource(255);
const TRANSLUCENT = pngSource(128);

/** Records every `src` the driver asked for: the read must happen once, with the src given. */
function reader(bytes: Uint8Array): {
  read: (src: string) => Promise<Uint8Array>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    read: async (src: string) => {
      calls.push(src);
      return bytes;
    },
  };
}

describe('builtinImageDriver', () => {
  test('resizes real bytes and names itself, not a Bun API that never shipped', async () => {
    const io = reader(OPAQUE);
    const driver = builtinImageDriver({ read: io.read });
    expect(driver.name).toBe('builtin');

    const result = await driver.transform({ src: '/img/hero.png', width: 32 });
    const probed = probeImage(result.bytes);
    expect(probed.width).toBe(32);
    expect(probed.height).toBe(24);
    expect(result.contentType).toBe(probed.mimeType);
    expect(result.width).toBe(32);
    expect(result.height).toBe(24);
  });

  test('reports the clamped size, not the requested one — the reserved box must be true', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    const result = await driver.transform({ src: '/img/hero.png', width: 512 });
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(probeImage(result.bytes).width).toBe(64);
  });

  test('with no format asked for, the source format is KEPT — alpha can never be lost', async () => {
    // The old rule guessed from the pixels and turned an opaque PNG into a JPEG; this one cannot
    // flatten a logo, because the only way out of PNG is asking for it.
    const alpha = builtinImageDriver({ read: reader(TRANSLUCENT).read });
    const opaque = builtinImageDriver({ read: reader(OPAQUE).read });
    expect((await alpha.transform({ src: '/logo.png', width: 32 })).contentType).toBe('image/png');
    expect((await opaque.transform({ src: '/photo.png', width: 32 })).contentType).toBe(
      'image/png',
    );

    const jpeg = await opaque.transform({ src: '/photo.png', width: 32, format: 'jpeg' });
    const fromJpeg = builtinImageDriver({ read: reader(jpeg.bytes).read });
    expect((await fromJpeg.transform({ src: '/photo.jpg', width: 16 })).contentType).toBe(
      'image/jpeg',
    );
  });

  test('an explicit format is honoured when the pipeline can encode it', async () => {
    const driver = builtinImageDriver({ read: reader(TRANSLUCENT).read, quality: 70 });
    const result = await driver.transform({ src: '/logo.png', width: 32, format: 'jpeg' });
    expect(result.contentType).toBe('image/jpeg');
    expect(probeImage(result.bytes).format).toBe('jpeg');
  });

  test('avif is X_IMAGE_UNSUPPORTED from core, not a SeoError wrapper', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    await expect(
      driver.transform({ src: '/img/hero.png', width: 32, format: 'avif' }),
    ).rejects.toMatchObject({ code: 'X_IMAGE_UNSUPPORTED' });
  });

  test('webp is served by the builtin driver now, not only by a CDN one', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    const result = await driver.transform({ src: '/img/hero.png', width: 32, format: 'webp' });
    expect(result.contentType).toBe('image/webp');
    expect(probeImage(result.bytes)).toMatchObject({ format: 'webp', width: 32, height: 24 });
  });

  test('a string that names no format is the same failure, and the fix lists the real ones', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    // 'jpg' is the near-miss a filename hands back: one code, and the fix names 'jpeg'.
    await expect(
      driver.transform({ src: '/img/hero.png', width: 32, format: 'jpg' }),
    ).rejects.toMatchObject({ code: 'X_IMAGE_UNSUPPORTED', fix: expect.stringContaining('jpeg') });
  });

  test('blurPlaceholder is a ThumbHash PNG data URI, at most 32px on its long edge', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    const uri = await driver.blurPlaceholder('/img/hero.png');
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    const info = probeImage(Uint8Array.from(atob(uri.split(',')[1] ?? ''), (c) => c.charCodeAt(0)));
    expect(info.format).toBe('png');
    expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(32);
    expect(uri.length).toBeLessThan(2048);
  });

  /**
   * The README's route example, verbatim in shape: `parseImageQuery` → `transform`. It lives here
   * because a snippet nothing compiles is a snippet that drifts — this one dropped `quality`, so a
   * route copied from the docs answered `?q=40` with the default encode and no error anywhere.
   */
  test('the documented route shape forwards every key parseImageQuery returns', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    const encode = async (search: string): Promise<TransformedImage> => {
      const query = parseImageQuery(new URL(`https://x.test/media/hero.png${search}`).searchParams);
      if (query === null) return expect.unreachable('the URL carries a transform');
      return await driver.transform({
        src: '/img/hero.png',
        width: query.width ?? 64,
        ...(query.format === undefined ? {} : { format: query.format }),
        ...(query.quality === undefined ? {} : { quality: query.quality }),
      });
    };

    const coarse = await encode(
      `?${IMAGE_QUERY_KEYS.width}=64&${IMAGE_QUERY_KEYS.format}=jpeg&${IMAGE_QUERY_KEYS.quality}=20`,
    );
    const fine = await encode(
      `?${IMAGE_QUERY_KEYS.width}=64&${IMAGE_QUERY_KEYS.format}=jpeg&${IMAGE_QUERY_KEYS.quality}=95`,
    );
    expect(coarse.contentType).toBe('image/jpeg');
    expect(coarse.width).toBe(64);
    // A dropped `quality` makes these two identical, which is the failure the docs example had.
    expect(coarse.bytes.length).toBeLessThan(fine.bytes.length);
  });

  test('reads once per call, with the exact src it was handed', async () => {
    const io = reader(OPAQUE);
    const driver = builtinImageDriver({ read: io.read });
    await driver.transform({ src: '/img/a b.png?v=2', width: 32 });
    expect(io.calls).toEqual(['/img/a b.png?v=2']);
    await driver.blurPlaceholder('/img/a b.png?v=2');
    expect(io.calls).toEqual(['/img/a b.png?v=2', '/img/a b.png?v=2']);
  });
});

describe('notImplementedDriver', () => {
  test('stays the vocabulary a partial user-supplied driver reports with', () => {
    const error = notImplementedDriver('cloudflare', 'blurPlaceholder()', 'app/cdn-image.ts');
    expect(error.code).toBe('X_NOT_IMPLEMENTED');
    expect(error.cause).toContain('cloudflare');
    expect(error.fix).toContain('blurPlaceholder()');
    expect(error.fix).toContain('builtinImageDriver');
  });

  test('names the driver source and ends in a command an agent can run', () => {
    const error = notImplementedDriver('cloudflare', 'transform()', 'app/cdn-image.ts');
    expect(error.fix).toContain('app/cdn-image.ts');
    expect(error.fix).toContain('x verify --json');
    expect(error.meta).toEqual({
      driver: 'cloudflare',
      capability: 'transform()',
      at: 'app/cdn-image.ts',
    });
  });
});
