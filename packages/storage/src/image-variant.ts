// Single responsibility: `variant()` — one resized image, made by the app's image driver and kept on
// the disk under `variantKey(…, { revision })`, so the second ask is a `stat` and never a decode.
// The driver is an ARGUMENT, structurally `@ultimat3/seo`'s `ImageTransformDriver`: storage is tier
// 1 beside seo and imports none of it; the `images` port value is what an app passes.

import { assert, finiteCount, IMAGE_MIME_TYPES } from '@ultimat3/core';
import type { StorageDriver, StorageObject } from './driver';
import { objectNotFound } from './errors';
import {
  driverEncodingMismatch,
  notARaster,
  variantFormatUnknown,
  variantSourceChanged,
} from './errors-variant';
import { type VariantFormat, variantFormatOf, variantKey, variantRevision } from './image';
import { normalizeContentType } from './upload';

/** `@ultimat3/seo`'s `TransformRequest`, field for field: `src` is the SOURCE storage key. */
export interface VariantRequest {
  src: string;
  width: number;
  format?: string;
  quality?: number;
}

/** `@ultimat3/seo`'s `TransformedImage`, field for field. */
export interface VariantBytes {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
}

/**
 * The half of `ImageTransformDriver` this needs — so `runtime.ts`'s `images` driver, a
 * `builtinImageDriver({ read: (src) => disk.get(src).then((r) => r.bytes) })` or a CDN's, is passed
 * as it is. Its `read` must resolve `src` against the SAME disk handed to `variant()`.
 */
export interface VariantTransformer {
  readonly name: string;
  transform(request: VariantRequest): Promise<VariantBytes>;
}

export interface VariantOptions {
  readonly disk: StorageDriver;
  readonly images: VariantTransformer;
  /** Whole pixels, at least one. A width above the source's is the driver's to clamp. */
  readonly width: number;
  /** Omitted: the source's own encoding (png, jpeg, webp); a gif or avif source must name one. */
  readonly format?: VariantFormat | undefined;
}

export interface StoredVariant {
  readonly key: string;
  readonly object: StorageObject;
  /** True when THIS call transformed and wrote it; false when it was already on the disk. */
  readonly created: boolean;
}

/** What a driver can resample: every raster core can probe. An svg has no pixels to resize. */
const RASTER_TYPES: ReadonlySet<string> = new Set(
  Object.entries(IMAGE_MIME_TYPES)
    .filter(([format]) => format !== 'svg')
    .map(([, type]) => type),
);

/**
 * The variant of `key` at `width` (and `format`), from the disk if it is there, else transformed by
 * `images` and written. Idempotent: the key is derived from the source's revision, so a repeat is a
 * hit and an overwritten source is a different key. Concurrent first calls both write the same key
 * with the same bytes — harmless, and cheaper than a lock.
 */
export async function variant(key: string, options: VariantOptions): Promise<StoredVariant> {
  const width = finiteCount('variant', 'width', options.width, 1);
  const { disk, images } = options;
  const source = await disk.stat(key);
  if (source === undefined) throw objectNotFound(disk.name, key);
  const sourceType = normalizeContentType(source.contentType);
  if (!RASTER_TYPES.has(sourceType)) throw notARaster(key, sourceType);
  const format = options.format === undefined ? variantFormatOf(sourceType) : options.format;
  if (format === undefined) throw variantFormatUnknown(key, sourceType);
  const revision = variantRevision(source.etag);
  assert(
    revision !== undefined,
    `variant('${key}'): the source etag "${source.etag}" carries no 8-hex revision, so its variant has no key that an overwrite would miss`,
    `x doctor --json   # the disk driver answers no content etag; serve ${key} through /media/* instead, which transforms without storing`,
  );
  const target = variantKey(key, { width, format, revision });

  const stored = await disk.stat(target);
  if (stored !== undefined) return { key: target, object: stored, created: false };

  const made = await images.transform({ src: key, width, format });
  const expected = IMAGE_MIME_TYPES[format];
  if (normalizeContentType(made.contentType) !== expected) {
    throw driverEncodingMismatch(key, images.name, expected, made.contentType);
  }
  // The driver read the source itself: bracketing it with two stats is how these bytes are known to
  // be the revision the key names, and not an overwrite that landed while it read.
  const after = await disk.stat(key);
  if (after?.etag !== source.etag) {
    throw variantSourceChanged(key, source.etag, after?.etag ?? 'deleted');
  }
  const object = await disk.put(target, made.bytes, { contentType: expected });
  return { key: target, object, created: true };
}
