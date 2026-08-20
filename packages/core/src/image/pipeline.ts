// Single responsibility: THE image pipeline. Decode -> resize -> encode, one entry point, one
// capability list. `storage`, `seo` and `pwa` all call this file and none of them owns a second
// copy: responsive variants, blur placeholders and PWA icons are the same three steps with
// different numbers, and a framework that generated them twice would drift twice.

import { composeOnto, layOut, type ResizeSpec } from './canvas';
import { imageFromBunError, imageUnsupported } from './errors';
import { unshared } from './png-bytes';
import { decodeImage, encodeImage } from './png-pixels';
import { IMAGE_MIME_TYPES, type ImageFormat } from './probe';
import { MAX_IMAGE_PIXELS } from './raster';

/**
 * What the pipeline can produce, on every platform, byte for byte. `Bun.Image` also reaches
 * HEIC and AVIF **through an OS codec** — Apple's ImageIO, Windows' WIC — which is a variant
 * that exists on the developer's laptop and not on the Linux node that serves it, under a key
 * that says nothing about which machine minted it. `backend = 'bun'` below refuses that trade,
 * so those two formats are refused HERE rather than silently on one deploy out of two: a caller
 * that needs them routes transforms through a driver (`@ultimat3/seo`'s `ImageTransformDriver`).
 */
export const ENCODABLE_FORMATS = ['png', 'jpeg', 'webp'] as const;
/** What the static codecs read. `svg` is markup, and `probeImage` measures it without decoding. */
export const DECODABLE_FORMATS = ['png', 'jpeg', 'webp', 'gif'] as const;

export type DecodableFormat = (typeof DECODABLE_FORMATS)[number];
export type EncodableFormat = (typeof ENCODABLE_FORMATS)[number];

export const canDecode = (format: string): format is DecodableFormat =>
  (DECODABLE_FORMATS as readonly string[]).includes(format);

export const canEncode = (format: string): format is EncodableFormat =>
  (ENCODABLE_FORMATS as readonly string[]).includes(format);

/** 1-100, lossy formats only. Bun's own default, pinned here so output cannot drift with it. */
export const DEFAULT_IMAGE_QUALITY = 80;

const encodeFix =
  "request 'png', 'jpeg' or 'webp', or route the transform through an ImageTransformDriver (a " +
  'CDN or an external encoder) that can produce it';

export interface ImageTransformSpec extends ResizeSpec {
  /** Defaults to the source's format when the pipeline can write it, PNG otherwise. */
  readonly format?: ImageFormat | undefined;
  /** 1-100, lossy formats only. */
  readonly quality?: number | undefined;
}

/**
 * `backend = 'bun'` is set on every call, not once at import. It forces the statically-linked
 * codecs and the Highway geometry kernels on every OS, which is what makes the same source and
 * the same spec the same BYTES on a laptop and on the node — and `variantKey` is content-
 * addressed, so a variant that re-encoded differently per platform would be a cache that never
 * hits and a hash that never agrees. Per call rather than at import because the property is
 * process-global and writable: an app that flips it back would otherwise silently win.
 */
function bunImage(bytes: Uint8Array): Bun.Image {
  Bun.Image.backend = 'bun';
  // The decompression-bomb ceiling, enforced by the decoder from the header before it allocates
  // — the same number `probeImage` refuses at, so the two answers cannot disagree.
  return new Bun.Image(unshared(bytes), { maxPixels: MAX_IMAGE_PIXELS });
}

function withFormat(image: Bun.Image, format: EncodableFormat, quality: number): Bun.Image {
  if (format === 'png') return image.png();
  if (format === 'jpeg') return image.jpeg({ quality });
  return image.webp({ quality });
}

/** Every rejection from `Bun.Image` becomes one of the three `X_IMAGE_*` codes, never a bare one. */
async function run<T>(doing: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw imageFromBunError(error, doing);
  }
}

/** The whole pipeline in one call: decode, resize, compose, encode. */
export async function transformImageBytes(
  bytes: Uint8Array,
  spec: ImageTransformSpec = {},
): Promise<Uint8Array> {
  const { format } = spec;
  // The spec alone answers "can this be written?", so answer it here — decoding and resampling
  // 64 megapixels first, only to refuse at the encoder, is work nobody can use.
  if (format !== undefined && !canEncode(format)) {
    throw imageUnsupported(`encoding ${format} is not built in`, encodeFix, { format });
  }
  const quality = spec.quality ?? DEFAULT_IMAGE_QUALITY;
  const source = await run('reading the image header', () => bunImage(bytes).metadata());
  const output: EncodableFormat = format ?? (canEncode(source.format) ? source.format : 'png');
  const layout = layOut(source, spec);
  const { box, drawn } = layout;

  if (!layout.needsCanvas) {
    return run('transforming the image', () => {
      const image = bunImage(bytes);
      if (box.width !== source.width || box.height !== source.height) {
        image.resize(box.width, box.height, { fit: 'fill' });
      }
      return withFormat(image, output, quality).bytes();
    });
  }

  // The letterbox / padding / crop path. `Bun.Image` resamples but has no compositor, so the
  // artwork comes back as PNG, is placed on the canvas here, and goes back through Bun to be
  // written. Back through Bun even when the output IS png: `png-pixels.ts` writes filter 0, which
  // is 1.2-1.8x libspng's bytes on a real icon (measured), and one writer for everything this
  // function returns is also what makes "same input, same bytes" rest on the static codecs alone.
  const art = await run('resampling the image', () =>
    bunImage(bytes).resize(drawn.width, drawn.height, { fit: 'fill' }).png().bytes(),
  );
  const composed = encodeImage(composeOnto(decodeImage(art), layout));
  return run('encoding the image', () => withFormat(bunImage(composed), output, quality).bytes());
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
