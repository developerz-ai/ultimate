// Single responsibility: THE image pipeline. Decode -> resize -> encode, one entry point, one
// capability list. `storage`, `seo` and `pwa` all call this file and none of them owns a second
// copy: responsive variants, blur placeholders and PWA icons are the same three steps with
// different numbers, and a framework that generated them twice would drift twice.

import { IMAGE_MIME_TYPES, type ImageFormat } from './probe';
import { rasterTransform } from './raster-pool';
import { bunImage, type ImageTransformSpec, run } from './transform-inline';

export type { DecodableFormat, EncodableFormat, ImageTransformSpec } from './transform-inline';
export {
  assertFiniteImageQuality,
  canDecode,
  canEncode,
  DECODABLE_FORMATS,
  DEFAULT_IMAGE_QUALITY,
  ENCODABLE_FORMATS,
} from './transform-inline';

/**
 * The whole pipeline in one call: decode, resize, compose, encode — in `raster-worker.ts`, off the
 * event loop. Measured on a 4096² source, the inline raster hops blocked the loop 98-1,945 ms; a
 * request waiting behind them waited that long. The bytes are `transformInline`'s, unchanged.
 */
export function transformImageBytes(
  bytes: Uint8Array,
  spec: ImageTransformSpec = {},
): Promise<Uint8Array> {
  return rasterTransform(bytes, spec);
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
 * The LQIP: a ThumbHash of the source as a `data:image/png;base64,` URI — at most 32px on its
 * long edge, with the source's average colour, aspect ratio and rough structure. PNG, so alpha
 * survives and no client-side decoder is needed to show it.
 */
export async function blurDataUrl(bytes: Uint8Array): Promise<string> {
  return run('building the blur placeholder', () => bunImage(bytes).placeholder());
}

export type { ImageFormat };
