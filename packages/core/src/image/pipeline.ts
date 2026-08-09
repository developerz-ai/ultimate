// Single responsibility: THE image pipeline. Decode -> resize -> encode, one entry point,
// one capability list. `storage`, `seo` and `pwa` all call this file and none of them owns a
// second copy: responsive variants, blur placeholders and PWA icons are the same three steps
// with different numbers, and a framework that generated them twice would drift twice.

import { imageUnsupported } from './errors';
import { decodeJpeg } from './jpeg-decode';
import { encodeJpeg } from './jpeg-encode';
import { DEFAULT_JPEG_QUALITY } from './jpeg-tables';
import { decodePng, encodePng } from './png';
import { IMAGE_MIME_TYPES, type ImageFormat, probeImage, sniffImageFormat } from './probe';
import { hasAlpha, type Raster } from './raster';
import { type ResizeSpec, resizeRaster } from './resize';

/**
 * What the built-in, zero-dependency pipeline can actually produce. Bun ships no image API and
 * the contract forbids `sharp`, so WebP and AVIF are *probed and served*, never synthesised
 * here — a caller that needs them routes transforms through a driver (see `@ultimat3/seo`'s
 * `ImageTransformDriver`). Publishing the real list is what stops `<source type="image/avif">`
 * from promising a variant nothing can encode.
 */
export const DECODABLE_FORMATS = ['png', 'jpeg'] as const;
export const ENCODABLE_FORMATS = ['png', 'jpeg'] as const;

export type DecodableFormat = (typeof DECODABLE_FORMATS)[number];
export type EncodableFormat = (typeof ENCODABLE_FORMATS)[number];

export const canDecode = (format: ImageFormat): format is DecodableFormat =>
  (DECODABLE_FORMATS as readonly string[]).includes(format);

export const canEncode = (format: ImageFormat): format is EncodableFormat =>
  (ENCODABLE_FORMATS as readonly string[]).includes(format);

/** Small enough to inline in HTML, big enough to blur convincingly. */
export const BLUR_PLACEHOLDER_WIDTH = 16;

const decodeFix =
  'convert the source to PNG or JPEG before it reaches the pipeline, or pass a custom ' +
  'ImageTransformDriver that can read it';

const encodeFix =
  "request 'png' or 'jpeg', or route the transform through an ImageTransformDriver (a CDN " +
  'or an external encoder) that can produce it';

/** Bytes in, RGBA out. The only place a format is turned into pixels. */
export function decodeImage(bytes: Uint8Array): Raster {
  const format = sniffImageFormat(bytes);
  if (format === null) {
    throw imageUnsupported('the bytes match no image format this pipeline knows', decodeFix);
  }
  if (format === 'png') return decodePng(bytes);
  if (format === 'jpeg') return decodeJpeg(bytes);
  throw imageUnsupported(`decoding ${format} is not built in`, decodeFix, { format });
}

/** RGBA in, bytes out. `quality` is ignored by lossless formats. */
export function encodeImage(
  raster: Raster,
  format: ImageFormat,
  quality: number = DEFAULT_JPEG_QUALITY,
): Uint8Array {
  if (format === 'png') return encodePng(raster);
  if (format === 'jpeg') return encodeJpeg(raster, quality);
  throw imageUnsupported(`encoding ${format} is not built in`, encodeFix, { format });
}

export interface ImageTransformSpec extends ResizeSpec {
  /** Defaults to whichever encodable format preserves the source: PNG if it has alpha. */
  readonly format?: ImageFormat | undefined;
  /** 1-100, JPEG only. */
  readonly quality?: number | undefined;
}

/**
 * PNG keeps transparency, JPEG does not; picking by the pixels means a logo never silently
 * grows a black background because nobody passed `format`.
 */
export const defaultFormatFor = (raster: Raster): EncodableFormat =>
  hasAlpha(raster) ? 'png' : 'jpeg';

/** The whole pipeline in one call: decode, resize, encode. */
export function transformImageBytes(bytes: Uint8Array, spec: ImageTransformSpec = {}): Uint8Array {
  const source = decodeImage(bytes);
  const resized = resizeRaster(source, spec);
  return encodeImage(resized, spec.format ?? defaultFormatFor(resized), spec.quality);
}

/** Chunked because spreading a whole image into `String.fromCharCode` overflows the stack. */
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export const dataUrl = (bytes: Uint8Array, format: ImageFormat): string =>
  `data:${IMAGE_MIME_TYPES[format]};base64,${base64Of(bytes)}`;

/**
 * The LQIP: the source at 16px wide, as a `data:` URI. Always PNG — at this size a JPEG's
 * own headers cost more than the pixels, and alpha survives.
 */
export function blurDataUrl(bytes: Uint8Array, width: number = BLUR_PLACEHOLDER_WIDTH): string {
  const tiny = resizeRaster(decodeImage(bytes), { width });
  return dataUrl(encodePng(tiny), 'png');
}

export type { ImageFormat };
/** Intrinsic dimensions without decoding — this is what keeps CLS at 0 for every format. */
export { IMAGE_MIME_TYPES, probeImage, sniffImageFormat };
