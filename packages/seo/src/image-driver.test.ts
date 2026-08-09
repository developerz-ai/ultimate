import { describe, expect, test } from 'bun:test';
import { createRaster, encodeImage, probeImage, type Raster } from '@ultimat3/core';
import { notImplementedDriver } from './errors';
import { builtinImageDriver } from './image-driver';

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

  test('an alpha source stays PNG and an opaque one becomes JPEG when nobody asks', async () => {
    const alpha = builtinImageDriver({ read: reader(TRANSLUCENT).read });
    const opaque = builtinImageDriver({ read: reader(OPAQUE).read });
    expect((await alpha.transform({ src: '/logo.png', width: 32 })).contentType).toBe('image/png');
    expect((await opaque.transform({ src: '/photo.png', width: 32 })).contentType).toBe(
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
    await expect(
      driver.transform({ src: '/img/hero.png', width: 32, format: 'webp' }),
    ).rejects.toMatchObject({ code: 'X_IMAGE_UNSUPPORTED' });
  });

  test('a string that names no format is the same failure, and the fix lists the real ones', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    // 'jpg' is the near-miss `extensionOf()` hands back: one code, and the fix names 'jpeg'.
    await expect(
      driver.transform({ src: '/img/hero.png', width: 32, format: 'jpg' }),
    ).rejects.toMatchObject({ code: 'X_IMAGE_UNSUPPORTED', fix: expect.stringContaining('jpeg') });
  });

  test('blurPlaceholder is a 16px PNG data URI', async () => {
    const driver = builtinImageDriver({ read: reader(OPAQUE).read });
    const uri = await driver.blurPlaceholder('/img/hero.png');
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect(
      probeImage(Uint8Array.from(atob(uri.split(',')[1] ?? ''), (c) => c.charCodeAt(0))),
    ).toMatchObject({ format: 'png', width: 16 });
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
    const error = notImplementedDriver('cloudflare', 'blurPlaceholder()');
    expect(error.code).toBe('X_NOT_IMPLEMENTED');
    expect(error.cause).toContain('cloudflare');
    expect(error.fix).toContain('blurPlaceholder()');
    expect(error.fix).toContain('builtinImageDriver');
  });
});
