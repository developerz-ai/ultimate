// The refusals of `variant()` (`image-variant.ts`). A source that is no raster and a driver that
// answered another encoding are core's `X_IMAGE_UNSUPPORTED`, as every other image refusal here is;
// a source overwritten mid-transform is storage's `X_STORAGE_OBJECT_CHANGED`.

import { type ImageUnsupportedError, imageUnsupported, renderFixLiteral } from '@ultimat3/core';
import { StorageError } from './errors';

export const notARaster = (key: string, contentType: string): ImageUnsupportedError =>
  imageUnsupported(
    `"${key}" is stored as ${contentType}, which is not a raster image, so it has no width to resize to`,
    `await disk.stat(${renderFixLiteral(key, "'<key>'")})   # variant() takes a png, jpeg, webp, gif or avif source: check its contentType, or serve it as-is`,
    { key, contentType },
  );

export const variantFormatUnknown = (key: string, contentType: string): ImageUnsupportedError =>
  imageUnsupported(
    `"${key}" is a ${contentType} source and no variant format was named, so no key can say what the transform will answer`,
    `variant(${renderFixLiteral(key, "'<key>'")}, { disk, images, width, format: 'webp' })`,
    { key, contentType },
  );

export const driverEncodingMismatch = (
  key: string,
  driver: string,
  expected: string,
  actual: string,
): ImageUnsupportedError =>
  imageUnsupported(
    `the ${driver} image driver answered ${actual} for "${key}", whose key names ${expected}, so the bytes would be served under the wrong type`,
    `variant(${renderFixLiteral(key, "'<key>'")}, { disk, images, width, format: '<the format the ${driver} driver produces>' })   # or make its transform() honour request.format`,
    { key, driver, expected, actual },
  );

export const variantSourceChanged = (key: string, expected: string, actual: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_OBJECT_CHANGED',
    cause: `"${key}" was overwritten while its variant was being made (etag ${expected} → ${actual}), so the bytes cannot be filed under either revision`,
    fix: `variant(${renderFixLiteral(key, "'<key>'")}, { disk, images, width }) again — it keys the variant by the new revision`,
    meta: { key, expected, actual },
  });
