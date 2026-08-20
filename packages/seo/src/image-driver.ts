// The bytes half of the image contract: `images.ts` decides what the markup promises, this
// file produces the variant that promise refers to. Split because they fail differently — a
// wrong `srcset` is a pure-function bug, a wrong variant is a decode — and because a project
// swapping in a CDN replaces only this half.

import {
  blurDataUrl,
  IMAGE_FORMATS,
  IMAGE_MIME_TYPES,
  type ImageFormat,
  imageUnsupported,
  probeImage,
  transformImageBytes,
} from '@ultimat3/core';

export interface TransformRequest {
  src: string;
  width: number;
  format?: string;
  quality?: number;
}

export interface TransformedImage {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
}

/** Swappable so a project can route transforms through a CDN instead. */
export interface ImageTransformDriver {
  readonly name: string;
  transform(request: TransformRequest): Promise<TransformedImage>;
  /** Tiny base64 data URI (typically a 16px-wide blur) for the placeholder. */
  blurPlaceholder(src: string): Promise<string>;
}

export interface BuiltinImageDriverOptions {
  /**
   * Resolves a `src` to its bytes. Required: seo must not guess whether a src is a path, a
   * storage key or a URL — reading the filesystem off a URL-shaped string is exactly the
   * ambient default this package forbids everywhere else.
   */
  readonly read: (src: string) => Promise<Uint8Array>;
  /** Default JPEG quality for lossy output. */
  readonly quality?: number | undefined;
}

const isImageFormat = (value: string): value is ImageFormat =>
  (IMAGE_FORMATS as readonly string[]).includes(value);

/** A string naming no format at all fails with the same code an unencodable format does. */
function requestedFormat(format: string | undefined): ImageFormat | undefined {
  if (format === undefined || isImageFormat(format)) return format;
  throw imageUnsupported(
    `"${format}" names no image format`,
    `request one of ${IMAGE_FORMATS.join(', ')}, or omit format to keep the source's`,
    { format },
  );
}

/**
 * The zero-dependency pipeline in `@ultimat3/core`: PNG, JPEG, WebP and GIF in, PNG, JPEG and
 * WebP out. `<picture>` still offers AVIF, and nothing here synthesises it — asking for one
 * raises core's `X_IMAGE_UNSUPPORTED`, and that variant belongs on a CDN driver instead.
 */
export function builtinImageDriver(options: BuiltinImageDriverOptions): ImageTransformDriver {
  return {
    name: 'builtin',
    async transform(request: TransformRequest): Promise<TransformedImage> {
      const bytes = await transformImageBytes(await options.read(request.src), {
        width: request.width,
        // Omitted means core keeps the source's format when it can write it, PNG otherwise.
        format: requestedFormat(request.format),
        quality: request.quality ?? options.quality,
      });
      // Read back off the output, never assumed: a width clamped to the source has to report
      // the source's size, or the box the browser reserved is the wrong one.
      const info = probeImage(bytes);
      return {
        bytes,
        contentType: IMAGE_MIME_TYPES[info.format],
        width: info.width,
        height: info.height,
      };
    },
    async blurPlaceholder(src: string): Promise<string> {
      return blurDataUrl(await options.read(src));
    },
  };
}
