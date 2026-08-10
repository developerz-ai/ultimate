// The responsive image contract: what the markup promises. Two non-negotiables — modern
// formats are offered before the fallback, and the intrinsic width/height are always inlined
// so the browser reserves the box before the bytes arrive, keeping CLS at 0. Producing those
// bytes is `image-driver.ts`; nothing here decodes a pixel.

import { attributes, escapeAttribute } from './xml';

/** Ordered widest-first is wrong for `srcset`; browsers want ascending. */
export const DEFAULT_WIDTHS: readonly number[] = [320, 480, 640, 768, 1024, 1280, 1536, 1920];

/** Most-preferred first. The original format is always appended last. */
export const FORMAT_ORDER = ['avif', 'webp'] as const;

export type ModernFormat = (typeof FORMAT_ORDER)[number];

export const MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

export interface ImageInput {
  src: string;
  /** Intrinsic pixel dimensions. Required — this is what prevents layout shift. */
  width: number;
  height: number;
  /** Empty string only for decorative images. */
  alt: string;
  /** `sizes` attribute. Defaults to `100vw`, which is honest but conservative. */
  sizes?: string;
  /** LCP candidate: eager + high fetch priority + no lazy attribute. */
  priority?: boolean;
  /** Base64 data URI rendered behind the image while it loads. */
  blurDataUrl?: string;
}

export interface ImageSourceSet {
  readonly type: string;
  readonly srcset: string;
  readonly sizes: string;
}

export interface ResponsiveImage {
  readonly sources: readonly ImageSourceSet[];
  readonly img: {
    readonly src: string;
    readonly srcset: string;
    readonly sizes: string;
    readonly alt: string;
    readonly width: number;
    readonly height: number;
    readonly loading: 'lazy' | 'eager';
    readonly decoding: 'async' | 'sync';
    readonly fetchpriority: 'high' | 'auto';
    /** `aspect-ratio` plus the blur placeholder, when one was generated. */
    readonly style: string;
  };
}

export interface ResponsiveImageOptions {
  widths?: readonly number[];
  formats?: readonly ModernFormat[];
  /** Builds the URL for one variant. Defaults to `?w=&f=` query parameters. */
  urlFor?: (src: string, width: number, format?: string) => string;
}

export function extensionOf(src: string): string {
  return (src.split('?')[0]?.split('.').pop() ?? '').toLowerCase();
}

function defaultUrlFor(src: string, width: number, format?: string): string {
  const separator = src.includes('?') ? '&' : '?';
  return `${src}${separator}w=${width}${format === undefined ? '' : `&f=${format}`}`;
}

/** Never upscale: drop candidate widths above the intrinsic width. */
export function usableWidths(intrinsic: number, widths: readonly number[]): readonly number[] {
  const usable = widths.filter((width) => width <= intrinsic);
  if (usable.length === 0) return [intrinsic];
  return usable.includes(intrinsic) ? usable : [...usable, intrinsic];
}

export function srcsetFor(
  input: ImageInput,
  widths: readonly number[],
  format: string | undefined,
  urlFor: NonNullable<ResponsiveImageOptions['urlFor']>,
): string {
  return widths.map((width) => `${urlFor(input.src, width, format)} ${width}w`).join(', ');
}

export function responsiveImage(
  input: ImageInput,
  options: ResponsiveImageOptions = {},
): ResponsiveImage {
  const urlFor = options.urlFor ?? defaultUrlFor;
  const widths = usableWidths(input.width, options.widths ?? DEFAULT_WIDTHS);
  const sizes = input.sizes ?? '100vw';
  const formats = options.formats ?? FORMAT_ORDER;

  const sources: ImageSourceSet[] = formats.map((format) => ({
    type: MIME_TYPES[format] ?? `image/${format}`,
    srcset: srcsetFor(input, widths, format, urlFor),
    sizes,
  }));

  const style = [
    `aspect-ratio:${input.width}/${input.height}`,
    input.blurDataUrl === undefined
      ? ''
      : `background-image:url(${input.blurDataUrl});background-size:cover`,
  ]
    .filter((part) => part !== '')
    .join(';');

  return {
    sources,
    img: {
      src: urlFor(input.src, widths[widths.length - 1] ?? input.width, undefined),
      srcset: srcsetFor(input, widths, undefined, urlFor),
      sizes,
      alt: input.alt,
      width: input.width,
      height: input.height,
      loading: input.priority === true ? 'eager' : 'lazy',
      decoding: input.priority === true ? 'sync' : 'async',
      fetchpriority: input.priority === true ? 'high' : 'auto',
      style,
    },
  };
}

/** `<picture>` with AVIF, then WebP, then the original. */
export function renderPicture(image: ResponsiveImage): string {
  const sources = image.sources
    .map(
      (source) =>
        `<source${attributes({ type: source.type, srcset: source.srcset, sizes: source.sizes })}>`,
    )
    .join('');
  const img = image.img;
  return `<picture>${sources}<img${attributes({
    src: img.src,
    srcset: img.srcset,
    sizes: img.sizes,
    alt: img.alt,
    width: String(img.width),
    height: String(img.height),
    loading: img.loading,
    decoding: img.decoding,
    fetchpriority: img.fetchpriority,
    style: img.style,
  })}></picture>`;
}

/** Escapes a data URI for inline `style`, for callers assembling their own tags. */
export function inlineBlur(dataUrl: string): string {
  return escapeAttribute(`background-image:url(${dataUrl});background-size:cover`);
}
