// Single responsibility: the three failure modes of the image pipeline, as coded errors, and the
// one translation of `Bun.Image`'s `ERR_IMAGE_*` rejections into them. Every one names the format
// AND a runnable way forward, because an agent that hits "unsupported" needs to know which format
// to ask for instead, not that it lost.

import { renderThrowable, stringField } from '../error-render';
import { UltimateError } from '../errors';

export class ImageUnsupportedError extends UltimateError {
  static readonly code = 'X_IMAGE_UNSUPPORTED';
  override readonly name = 'ImageUnsupportedError';
  constructor(cause: string, fix: string, meta?: Readonly<Record<string, unknown>>) {
    super({ code: ImageUnsupportedError.code, cause, fix, meta });
  }
}

export class ImageDecodeFailedError extends UltimateError {
  static readonly code = 'X_IMAGE_DECODE_FAILED';
  override readonly name = 'ImageDecodeFailedError';
  constructor(cause: string, fix: string, meta?: Readonly<Record<string, unknown>>) {
    super({ code: ImageDecodeFailedError.code, cause, fix, meta });
  }
}

export class ImageTooLargeError extends UltimateError {
  static readonly code = 'X_IMAGE_TOO_LARGE';
  override readonly name = 'ImageTooLargeError';
  constructor(cause: string, fix: string, meta?: Readonly<Record<string, unknown>>) {
    super({ code: ImageTooLargeError.code, cause, fix, meta });
  }
}

/** A format or a coding feature the built-in pipeline does not implement. */
export const imageUnsupported = (
  cause: string,
  fix: string,
  meta?: Readonly<Record<string, unknown>>,
): ImageUnsupportedError => new ImageUnsupportedError(cause, fix, meta);

/** Malformed, truncated or internally inconsistent bytes. Never a silent black image. */
export const imageDecodeFailed = (
  cause: string,
  meta?: Readonly<Record<string, unknown>>,
): ImageDecodeFailedError =>
  new ImageDecodeFailedError(
    cause,
    're-export the image from its source: `file <path>` reports what these bytes actually are',
    meta,
  );

/** The decompression-bomb guard: pixel count is checked from the header, before allocation. */
export const imageTooLarge = (
  cause: string,
  meta?: Readonly<Record<string, unknown>>,
): ImageTooLargeError =>
  new ImageTooLargeError(
    cause,
    'downscale the source before it reaches the pipeline, or raise MAX_IMAGE_PIXELS deliberately',
    meta,
  );

/**
 * `Bun.Image` rejects with a plain `Error` carrying a stable `error.code`. This is the ONE place
 * that code is read: a caller branching on `ERR_IMAGE_*` would be a second vocabulary for the same
 * three failures, and `X_IMAGE_*` is the one the rest of the framework, the wiki and `x errors
 * explain` already know. Unknown codes land on decode-failed rather than on a bare `Error`.
 */
const UNSUPPORTED_FIX =
  "request 'png', 'jpeg' or 'webp' — AVIF and HEIC need an OS codec the portable backend never " +
  'uses, so route those through an ImageTransformDriver (a CDN or an external encoder)';

const UNKNOWN_FORMAT_FIX =
  're-export the source as PNG, JPEG or WebP: `file <path>` reports what these bytes actually are';

export function imageFromBunError(value: unknown, doing: string): UltimateError {
  // `renderThrowable`, never `${value}` — the rejection is Bun's value, not ours, and a cause that
  // throws while formatting itself replaces the refusal with a TypeError nothing catches by code.
  const cause = `${doing}: ${renderThrowable(value)}`;
  const code = stringField(value, 'code');
  if (code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') {
    return new ImageUnsupportedError(cause, UNSUPPORTED_FIX, { bunCode: code });
  }
  if (code === 'ERR_IMAGE_UNKNOWN_FORMAT') {
    return new ImageUnsupportedError(cause, UNKNOWN_FORMAT_FIX, { bunCode: code });
  }
  if (code === 'ERR_IMAGE_TOO_MANY_PIXELS') {
    return imageTooLarge(cause, { bunCode: code });
  }
  return imageDecodeFailed(cause, code === undefined ? {} : { bunCode: code });
}
