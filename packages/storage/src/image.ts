// Single responsibility: the image transform contract over Bun's native image pipeline.
// `@ultimat3/seo` builds `<img srcset>` from `srcsetDescriptors()`, so width lists, derived
// variant keys and aspect-ratio fitting are deterministic pure functions here — SEO must emit
// markup without decoding a byte or touching a disk. Only the encode path needs the pipeline.

import { storageNotImplemented } from './errors';
import { assertSafeKey, keyExtname } from './path';

export const IMAGE_FORMATS = ['avif', 'webp', 'jpeg'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** `cover` fills the box and crops the overflow; `contain` fits inside it, no crop. */
export type ImageFit = 'cover' | 'contain';

export interface ImageTransform {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly format?: ImageFormat | undefined;
  /** 1-100. Omitted means the format default (`DEFAULT_QUALITY`). */
  readonly quality?: number | undefined;
  readonly fit?: ImageFit | undefined;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_QUALITY = 80;
export const DEFAULT_SRCSET_WIDTHS = [320, 640, 960, 1280, 1920] as const;
/** Small enough to inline in HTML; big enough to blur convincingly. */
export const BLUR_PLACEHOLDER_WIDTH = 16;

const FORMAT_EXTENSIONS: Readonly<Record<ImageFormat, string>> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpg',
};

/**
 * Derived, not stored: the same source + transform always yields the same key, so a variant
 * is a cache lookup rather than a database row.
 */
export function variantKey(sourceKey: string, transform: ImageTransform): string {
  const safe = assertSafeKey(sourceKey);
  const stem = safe.slice(0, safe.length - keyExtname(safe).length);
  const format = transform.format ?? 'webp';
  const parts: string[] = [];
  if (transform.width !== undefined) parts.push(`w${transform.width}`);
  if (transform.height !== undefined) parts.push(`h${transform.height}`);
  if (transform.fit !== undefined) parts.push(transform.fit);
  const quality = transform.quality ?? DEFAULT_QUALITY;
  if (quality !== DEFAULT_QUALITY) parts.push(`q${quality}`);
  if (parts.length === 0) parts.push('full');
  return assertSafeKey(`${stem}@${parts.join('-')}.${FORMAT_EXTENSIONS[format]}`);
}

export interface SrcsetDescriptor {
  readonly width: number;
  readonly key: string;
  /** The `srcset` entry suffix, e.g. `640w`. */
  readonly descriptor: string;
}

export interface SrcsetOptions {
  readonly widths?: readonly number[] | undefined;
  readonly format?: ImageFormat | undefined;
  readonly quality?: number | undefined;
  /** Intrinsic size of the source. Widths above it are dropped — upscaling is never useful. */
  readonly intrinsic?: ImageSize | undefined;
}

/** The widths + variant keys `@ultimat3/seo` turns into a `srcset` attribute. */
export function srcsetDescriptors(
  sourceKey: string,
  options: SrcsetOptions = {},
): readonly SrcsetDescriptor[] {
  const widths = options.widths ?? DEFAULT_SRCSET_WIDTHS;
  const max = options.intrinsic?.width;
  return widths
    .filter((width) => width > 0 && (max === undefined || width <= max))
    .map((width) => ({
      width,
      key: variantKey(sourceKey, {
        width,
        format: options.format ?? 'webp',
        quality: options.quality,
      }),
      descriptor: `${width}w`,
    }));
}

/** Aspect-ratio fitting. `cover` rounds up so the box is always fully covered. */
export function fitDimensions(source: ImageSize, transform: ImageTransform): ImageSize {
  const ratio = source.height / source.width;
  const { width, height } = transform;
  if (width === undefined && height === undefined) return source;
  if (height === undefined) {
    const target = Math.min(width ?? source.width, source.width);
    return { width: target, height: Math.round(target * ratio) };
  }
  if (width === undefined) {
    const target = Math.min(height, source.height);
    return { width: Math.round(target / ratio), height: target };
  }
  // `cover` crops to the exact box; `contain` scales down until both sides fit.
  if (transform.fit === 'cover') return { width, height };
  const scale = Math.min(width / source.width, height / source.height);
  return { width: Math.round(source.width * scale), height: Math.round(source.height * scale) };
}

const ENCODE_FIX =
  'x storage image --check   # reports the Bun image API binding; until it lands, ' +
  'pre-generate variants at upload time or point routes at the original key';

/** Encode path. Deterministic key/descriptor math above works without it. */
export function transformImage(_bytes: Uint8Array, transform: ImageTransform): Promise<Uint8Array> {
  throw storageNotImplemented(
    `image encode to ${transform.format ?? 'webp'} (Bun's native image pipeline is not bound yet)`,
    ENCODE_FIX,
  );
}

/** A `data:` URI small enough to inline as the LQIP behind a real image. */
export function blurPlaceholder(_bytes: Uint8Array): Promise<string> {
  throw storageNotImplemented(
    `blur placeholder encode at ${BLUR_PLACEHOLDER_WIDTH}px (needs the image pipeline)`,
    ENCODE_FIX,
  );
}
