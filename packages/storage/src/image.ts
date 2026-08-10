// Single responsibility: the image transform contract — deterministic variant keys and srcset
// math, plus the byte path bound to `@ultimat3/core`'s pipeline. `@ultimat3/seo` builds
// `<img srcset>` from `srcsetDescriptors()` without decoding a byte, and when it does need the
// bytes, `transformImage()` returns exactly the size `fitDimensions()` already promised.

import {
  blurDataUrl,
  BLUR_PLACEHOLDER_WIDTH as CORE_BLUR_PLACEHOLDER_WIDTH,
  probeImage,
  transformImageBytes,
} from '@ultimat3/core';
import { assertSafeKey, keyExtname } from './path';

export const IMAGE_FORMATS = ['avif', 'webp', 'jpeg', 'png'] as const;
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
/** Small enough to inline in HTML; big enough to blur convincingly. Core owns the number. */
export const BLUR_PLACEHOLDER_WIDTH = CORE_BLUR_PLACEHOLDER_WIDTH;

const FORMAT_EXTENSIONS: Readonly<Record<ImageFormat, string>> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpg',
  png: 'png',
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

/**
 * Decode, resize, encode — core's pipeline, which encodes **png and jpeg only**. `avif` and
 * `webp` stay key/`srcset` math: asking for their bytes rejects with core's
 * `X_IMAGE_UNSUPPORTED` (not re-wrapped — one failure, one code), and producing them means a
 * CDN or a custom `ImageTransformDriver`. PNG is also the only output that keeps alpha.
 *
 * The output box is `fitDimensions()`, always: that is the size `@ultimat3/seo` has already
 * written into the `<img>` tag, and bytes that disagreed with it would be the layout shift
 * this whole path exists to prevent.
 */
export async function transformImage(
  bytes: Uint8Array,
  transform: ImageTransform,
): Promise<Uint8Array> {
  // Header read, not a decode — the source size is needed before the box can be chosen.
  const size = fitDimensions(probeImage(bytes), transform);
  return transformImageBytes(bytes, {
    width: size.width,
    height: size.height,
    // The box already carries the fitted aspect ratio, so `cover` crops nothing real; it is
    // what stops a rounded edge leaving a transparent (in JPEG: black) sliver inside it.
    fit: 'cover',
    format: transform.format ?? 'webp',
    quality: transform.quality ?? DEFAULT_QUALITY,
  });
}

/** A `data:` URI small enough to inline as the LQIP behind a real image. Always PNG. */
export async function blurPlaceholder(bytes: Uint8Array): Promise<string> {
  return blurDataUrl(bytes, BLUR_PLACEHOLDER_WIDTH);
}
