// Single responsibility: the three failure modes of the image pipeline, as coded errors.
// Every one names the format AND a runnable way forward, because an agent that hits
// "unsupported" needs to know which format to ask for instead, not that it lost.

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
