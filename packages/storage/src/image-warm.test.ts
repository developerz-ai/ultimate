// `warmVariants` writes exactly the keys the media route looks up — the source key, the width, the
// format and the revision of the bytes it read — so a warmed variant is a hit and never a decode.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  blankRaster,
  encodeImage,
  frozenClock,
  isUltimateError,
  probeImage,
  transformImageBytes,
} from '@ultimat3/core';
import { memoryStorageDriver } from './driver-memory';
import { variantKey, variantRevision } from './image';
import { warmVariants } from './image-warm';
import { resetStorage } from './storage';

/** 40x20, opaque, a gradient — so two widths are two different encodings. */
function gradientPng(): Uint8Array {
  const raster = blankRaster(40, 20);
  for (let at = 0; at < raster.pixels.length; at += 4) {
    raster.pixels[at] = at % 251;
    raster.pixels[at + 1] = 90;
    raster.pixels[at + 2] = 128;
    raster.pixels[at + 3] = 255;
  }
  return encodeImage(raster, 'png');
}

const disk = () =>
  memoryStorageDriver({ signingSecret: 'test-secret', clock: frozenClock('2026-11-06T09:00:00Z') });

beforeEach(() => resetStorage());

describe('unit · warmVariants', () => {
  test('each width x format lands under variantKey with the source revision, as the route would mint it', async () => {
    const store = disk();
    const source = await store.put('p/hero.png', gradientPng(), { contentType: 'image/png' });
    const revision = variantRevision(source.etag);
    expect(revision).toBeDefined();

    const result = await warmVariants({
      disk: store,
      key: 'p/hero.png',
      widths: [20, 40],
      formats: ['webp', 'png'],
    });

    const expected = [20, 40].flatMap((width) =>
      (['webp', 'png'] as const).map((format) =>
        variantKey('p/hero.png', { width, format, revision }),
      ),
    );
    expect(result).toEqual({ written: expected, failed: [], skipped: [] });
    const warmed = await store.get(
      variantKey('p/hero.png', { width: 20, format: 'webp', revision }),
    );
    expect(warmed.object.contentType).toBe('image/webp');
    expect(probeImage(warmed.bytes).width).toBe(20);
    // The builtin driver's own spec, so the warmed bytes ARE the bytes a miss would have stored.
    expect(warmed.bytes).toEqual(
      await transformImageBytes(gradientPng(), { width: 20, format: 'webp' }),
    );
  });

  test('a width past the source is skipped, an avif fails alone with core code, the rest is written', async () => {
    const store = disk();
    await store.put('p/hero.png', gradientPng(), { contentType: 'image/png' });
    const result = await warmVariants({
      disk: store,
      key: 'p/hero.png',
      widths: [20, 640],
      formats: ['avif', 'webp'],
    });
    expect(result.skipped).toEqual([640]);
    expect(result.written).toHaveLength(1);
    expect(result.failed.map((one) => one.code)).toEqual(['X_IMAGE_UNSUPPORTED']);
  });

  test('a NaN width is refused before the source is read', async () => {
    let refused: unknown;
    try {
      await warmVariants({ disk: disk(), key: 'p/none.png', widths: [Number.NaN], formats: [] });
    } catch (error) {
      refused = error;
    }
    // Not X_STORAGE_NOT_FOUND: the screen ran before the read.
    expect(isUltimateError(refused) ? refused.code : refused).toBe('X_INVARIANT');
  });
});
