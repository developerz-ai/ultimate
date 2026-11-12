// Single responsibility: the transform itself, ON THE THREAD THAT CALLS IT — decode, resize,
// compose, encode. `pipeline.ts`'s `transformImageBytes` runs it inside `raster-worker.ts`; the
// event loop runs it only where no Worker can start, and there the web role holds it to a budget.

import { assert } from '../assert';
import { composeOnto, type Layout, layOut, type ResizeSpec } from './canvas';
import { imageFromBunError, imageRasterBudget, imageUnsupported } from './errors';
import { unshared } from './png-bytes';
import { decodeImage, encodeImage } from './png-pixels';
import type { ImageFormat } from './probe';
import { cropRaster, type ImageRegion, type ImageSize, MAX_IMAGE_PIXELS } from './raster';

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

/**
 * The encoder CLAMPS and never refuses, which is why this is a screen and not a comment. Exported
 * because `@ultimat3/storage` mints a variant KEY from the same number without ever reaching this
 * pipeline — two screens that refuse different qualities would mint `q150` keys for bytes this
 * encoder goes on to refuse, which is the dead-on-arrival shape `buildSignedUrl`'s own
 * `finiteCount` screen already exists for — that package held a private `assertFiniteSignedUrlBound`
 * until this sweep collapsed it onto the tier-0 check. Measured
 * on a 3x2 PNG re-encoded as JPEG: quality 80 wrote 663 bytes, and `NaN`, `-5` and `0` each wrote
 * 635 — the worst encoding the codec can make — while `Infinity` and `1e9` each wrote 719. Every
 * one of them silently. `Number(url.searchParams.get('q'))` is `NaN` when the parameter is absent,
 * so the degraded image is the one an unparameterised URL gets.
 */
export const assertFiniteImageQuality = (quality: number): number => {
  assert(
    Number.isInteger(quality) && quality >= 1 && quality <= 100,
    `image quality is ${String(quality)}, and the encoder clamps rather than refusing: it must be a whole number from 1 to 100`,
    `pass a whole quality from 1 to 100 — transformImageBytes(bytes, { quality: ${String(DEFAULT_IMAGE_QUALITY)} }) — and parse a query value before you pass it`,
  );
  return quality;
};

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
export function bunImage(bytes: Uint8Array): Bun.Image {
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
export async function run<T>(doing: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw imageFromBunError(error, doing);
  }
}

/**
 * `region` of the source as PNG. `Bun.Image` has no crop, so the source is decoded to a raster
 * (within the same `MAX_IMAGE_PIXELS` its header was held to) and the region copied out of it.
 */
async function croppedPng(bytes: Uint8Array, region: ImageRegion): Promise<Uint8Array> {
  const whole = await run('decoding the image', () => bunImage(bytes).png().bytes());
  return encodeImage(cropRaster(decodeImage(whole), region));
}

/**
 * The whole pipeline in one call: decode, resize, compose, encode. `syncBudget` is the most pixels
 * the two raster hops below — `png-pixels.ts`'s inflate and deflate, which block the thread — may
 * touch; past it the call is `X_IMAGE_RASTER_BUDGET` before either hop runs. Absent, no bound:
 * inside the Worker a long hop blocks nobody.
 */
export async function transformInline(
  bytes: Uint8Array,
  spec: ImageTransformSpec = {},
  syncBudget?: number,
): Promise<Uint8Array> {
  const { format } = spec;
  // The spec alone answers "can this be written?", so answer it here — decoding and resampling
  // 64 megapixels first, only to refuse at the encoder, is work nobody can use.
  if (format !== undefined && !canEncode(format)) {
    throw imageUnsupported(`encoding ${format} is not built in`, encodeFix, { format });
  }
  const quality = assertFiniteImageQuality(spec.quality ?? DEFAULT_IMAGE_QUALITY);
  const source = await run('reading the image header', () => bunImage(bytes).metadata());
  const output: EncodableFormat = format ?? (canEncode(source.format) ? source.format : 'png');
  const layout = layOut(source, spec);
  const { box, drawn, crop } = layout;
  if (syncBudget !== undefined) holdToBudget(source, layout, syncBudget);
  // The cropped region stands in for the source from here on: what is resampled is what shows.
  const input = crop === undefined ? bytes : await croppedPng(bytes, crop);
  const inputSize = crop ?? source;

  if (!layout.needsCanvas) {
    return run('transforming the image', () => {
      const image = bunImage(input);
      if (box.width !== inputSize.width || box.height !== inputSize.height) {
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
    bunImage(input).resize(drawn.width, drawn.height, { fit: 'fill' }).png().bytes(),
  );
  const composed = encodeImage(composeOnto(decodeImage(art), layout));
  return run('encoding the image', () => withFormat(bunImage(composed), output, quality).bytes());
}

/**
 * The pixels the synchronous hops would inflate plus those they would deflate: a crop decodes the
 * WHOLE source and encodes the region, a composite decodes the resampled art and encodes the
 * canvas. A plain resize touches none — `Bun.Image` resamples off the event loop (measured: 0-9 ms
 * worst gap on a 4096² source).
 */
function holdToBudget(source: ImageSize, layout: Layout, budget: number): void {
  const area = (size: ImageSize): number => size.width * size.height;
  const cropped = layout.crop === undefined ? 0 : area(source) + area(layout.crop);
  const composed = layout.needsCanvas ? area(layout.drawn) + area(layout.box) : 0;
  const pixels = cropped + composed;
  if (pixels > budget) throw imageRasterBudget(pixels, budget);
}
