// `variant()` over an `ImageTransformDriver`-shaped transformer: stored once under `variantKey` with
// the source's revision, answered from the disk ever after, refused for a non-image source.

import { describe, expect, test } from 'bun:test';
import {
  blankRaster,
  encodeImage,
  frozenClock,
  IMAGE_MIME_TYPES,
  isUltimateError,
  probeImage,
  transformImageBytes,
} from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { memoryStorageDriver } from './driver-memory';
import { variantKey, variantRevision } from './image';
import { type VariantTransformer, variant } from './image-variant';

function png(width: number, height: number): Uint8Array {
  const raster = blankRaster(width, height);
  raster.pixels.fill(200);
  return encodeImage(raster, 'png');
}

const disk = () =>
  memoryStorageDriver({ signingSecret: 's', clock: frozenClock('2026-11-09T00:00:00Z') });

/** `builtinImageDriver`'s behaviour, over the disk: what `@ultimat3/seo` hands `variant()`. */
function transformer(store: StorageDriver): VariantTransformer & { calls: number } {
  const self = {
    name: 'builtin-like',
    calls: 0,
    async transform(request: { src: string; width: number; format?: string }) {
      self.calls += 1;
      const source = await store.get(request.src);
      const format =
        request.format === 'jpeg' || request.format === 'png' ? request.format : 'webp';
      const bytes = await transformImageBytes(source.bytes, { width: request.width, format });
      const info = probeImage(bytes);
      return {
        bytes,
        contentType: IMAGE_MIME_TYPES[info.format],
        width: info.width,
        height: info.height,
      };
    },
  };
  return self;
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('variant() was expected to refuse');
}

describe('variant', () => {
  test('stores the transform under the derived key, then answers it without transforming again', async () => {
    const store = disk();
    const source = await store.put('p/hero.png', png(40, 20), { contentType: 'image/png' });
    const images = transformer(store);
    const first = await variant('p/hero.png', { disk: store, images, width: 10, format: 'webp' });
    const revision = variantRevision(source.etag);
    expect(first.key).toBe(variantKey('p/hero.png', { width: 10, format: 'webp', revision }));
    expect(first.created).toBe(true);
    expect(first.object.contentType).toBe('image/webp');
    expect(probeImage((await store.get(first.key)).bytes).width).toBe(10);

    const again = await variant('p/hero.png', { disk: store, images, width: 10, format: 'webp' });
    expect(again).toMatchObject({ key: first.key, created: false });
    expect(images.calls).toBe(1);
  });

  test('no format keeps the source encoding, and an overwritten source misses the old variant', async () => {
    const store = disk();
    await store.put('p/a.png', png(40, 20), { contentType: 'image/png' });
    const images = transformer(store);
    const before = await variant('p/a.png', { disk: store, images, width: 8 });
    expect(before.key.endsWith('.png')).toBe(true);
    await store.put('p/a.png', png(30, 30), { contentType: 'image/png' });
    const after = await variant('p/a.png', { disk: store, images, width: 8 });
    expect(after.key).not.toBe(before.key);
    expect(after.created).toBe(true);
  });

  test('a non-image source is refused with X_IMAGE_UNSUPPORTED and nothing is transformed', async () => {
    const store = disk();
    await store.put('d/report.pdf', new TextEncoder().encode('%PDF-1.7'), {
      contentType: 'application/pdf',
    });
    const images = transformer(store);
    // A format named, so the refusal is the source's type and not the missing format.
    const error = await caught(() =>
      variant('d/report.pdf', { disk: store, images, width: 10, format: 'webp' }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_IMAGE_UNSUPPORTED');
    expect(images.calls).toBe(0);
  });

  test('an svg source is refused: a vector has no width to resample to', async () => {
    const store = disk();
    await store.put(
      'd/logo.svg',
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      {
        contentType: 'image/svg+xml',
      },
    );
    const images = transformer(store);
    const error = await caught(() =>
      variant('d/logo.svg', { disk: store, images, width: 10, format: 'png' }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_IMAGE_UNSUPPORTED');
    expect(images.calls).toBe(0);
  });

  test('a missing source is X_STORAGE_NOT_FOUND', async () => {
    const store = disk();
    const error = await caught(() =>
      variant('p/none.png', { disk: store, images: transformer(store), width: 10 }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_NOT_FOUND');
  });

  test('a driver answering another encoding than the key names is refused, and nothing is stored', async () => {
    const store = disk();
    await store.put('p/b.png', png(40, 20), { contentType: 'image/png' });
    const liar = transformer(store);
    const images: VariantTransformer = {
      name: 'liar',
      transform: async (request) => ({
        ...(await liar.transform(request)),
        contentType: 'image/jpeg',
      }),
    };
    const error = await caught(() =>
      variant('p/b.png', { disk: store, images, width: 10, format: 'webp' }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_IMAGE_UNSUPPORTED');
    expect((await store.list({ prefix: 'p/b.png@' })).rows).toEqual([]);
  });

  test('a source overwritten while the driver read it is X_STORAGE_OBJECT_CHANGED, and nothing is stored', async () => {
    const store = disk();
    await store.put('p/d.png', png(40, 20), { contentType: 'image/png' });
    const inner = transformer(store);
    const images: VariantTransformer = {
      name: 'racing',
      async transform(request) {
        const made = await inner.transform(request);
        await store.put('p/d.png', png(20, 20), { contentType: 'image/png' });
        return made;
      },
    };
    const error = await caught(() => variant('p/d.png', { disk: store, images, width: 10 }));
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_OBJECT_CHANGED');
    expect((await store.list({ prefix: 'p/d.png@' })).rows).toEqual([]);
  });

  test('a width that is not a whole positive pixel count is refused before any read', async () => {
    const store = disk();
    await store.put('p/c.png', png(4, 4), { contentType: 'image/png' });
    const images = transformer(store);
    await expect(variant('p/c.png', { disk: store, images, width: Number.NaN })).rejects.toThrow();
    expect(images.calls).toBe(0);
  });
});
