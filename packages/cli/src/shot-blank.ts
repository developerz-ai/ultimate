// Is a captured picture a picture of anything? Judged by its PIXELS, never its byte count: a flat
// 36 px button is a few hundred honest bytes, and a blank 1280x800 crop compresses to about as few.
// One pure verdict over the decoded raster, so a test can hand it both and see them told apart.

import type { Raster } from '@ultimat3/core';
import { decodeImage, transformImageBytes } from '@ultimat3/core';

/**
 * The widest spread, per channel, a crop may have and still be ONE colour. Not 0: a GPU
 * compositor dithers a flat fill by a level or two, and that noise is not content. A hairline
 * border, a glyph or a focus ring against the page is tens of levels — an order of magnitude past it.
 */
export const BLANK_CHANNEL_SPREAD = 2;

/** The bytes as 8-bit RGBA: whatever PNG flavour the browser wrote, Bun re-encodes it to one. */
async function rasterOf(bytes: Uint8Array): Promise<Raster | null> {
  try {
    return decodeImage(await transformImageBytes(bytes, { format: 'png' }));
  } catch {
    // The caller's refusal is the report: bytes no decoder reads are "not an image", whichever
    // `X_IMAGE_*` code the decoder named.
    return null;
  }
}

export interface BlankShot {
  readonly reason: string;
  /** No decoder read the bytes: the browser's fault, not the crop's. */
  readonly undecodable: boolean;
}

/**
 * Why the picture shows nothing, or `undefined` when it shows something. Three refusals: bytes no
 * decoder reads, a crop with no opaque pixel, and a crop every pixel of which is one colour (within
 * `BLANK_CHANNEL_SPREAD`). Anything with two colours in it — a border on a background, a glyph —
 * passes, however few bytes it took.
 */
export async function blankShotReason(bytes: Uint8Array): Promise<BlankShot | undefined> {
  const raster = await rasterOf(bytes);
  if (raster === null) {
    return {
      reason: `produced ${bytes.byteLength} bytes no image decoder reads — that is not an image`,
      undecodable: true,
    };
  }
  const { pixels, width, height } = raster;
  const low = [255, 255, 255, 255];
  const high = [0, 0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) {
    for (let c = 0; c < 4; c += 1) {
      const value = pixels[i + c] ?? 0;
      if (value < (low[c] ?? 0)) low[c] = value;
      if (value > (high[c] ?? 0)) high[c] = value;
    }
  }
  if ((high[3] ?? 0) === 0) {
    return {
      reason: `produced a ${width}x${height} picture every pixel of which is fully transparent`,
      undecodable: false,
    };
  }
  const spread = Math.max(...high.map((value, c) => value - (low[c] ?? 0)));
  if (spread <= BLANK_CHANNEL_SPREAD) {
    return {
      reason: `produced a ${width}x${height} picture every pixel of which is one colour (rgba ${low.join(',')}) — nothing was painted in the crop`,
      undecodable: false,
    };
  }
  return undefined;
}
