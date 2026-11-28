// Two captures compared, the shared half of `ui.diff` and `x shot --against`: decode both PNGs
// through `@ultimat3/core`'s raw-pixel seam, count what changed by `ui-diff.ts`'s rule, and encode the
// diff picture. No file paths and no error codes — each caller gates its own paths and sizes.

import type { Raster } from '@ultimat3/core';
import {
  decodeImage,
  encodeImage,
  ImageUnsupportedError,
  transformImageBytes,
} from '@ultimat3/core';
import type { UiInspectBox } from '@ultimat3/mcp';
import { changedPercent, diffPixels } from './ui-diff';

/**
 * The seam reads 8-bit RGBA and nothing else. A PNG in any other shape — Chrome's RGB when the page
 * is opaque, a palette from an optimiser — goes once through Bun's codecs, which always write the
 * shape the seam reads. Only `imageUnsupported` is retried that way: a truncated file is a
 * truncated file in either decoder.
 */
export async function decodeCapture(bytes: Uint8Array): Promise<Raster> {
  try {
    return decodeImage(bytes);
  } catch (error) {
    if (!(error instanceof ImageUnsupportedError)) throw error;
    return decodeImage(await transformImageBytes(bytes, { format: 'png' }));
  }
}

/** Eight hex digits of the path's 64-bit hash: enough to keep two diffs of one `after` apart. */
export const hash8 = (text: string): string =>
  Bun.hash(text).toString(16).padStart(16, '0').slice(0, 8);

/**
 * `raster` on a `width`×`height` canvas, top-left, the rest transparent. A reference shot and a
 * route shot are both full-page and almost never one height: the part only one of them covers is
 * a difference, so it is compared as one rather than cropped away.
 */
export function padRaster(raster: Raster, width: number, height: number): Raster {
  if (raster.width === width && raster.height === height) return raster;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const rows = Math.min(raster.height, height);
  const rowBytes = Math.min(raster.width, width) * 4;
  for (let y = 0; y < rows; y += 1) {
    const from = y * raster.width * 4;
    pixels.set(raster.pixels.subarray(from, from + rowBytes), y * width * 4);
  }
  return { width, height, pixels };
}

/** The unchanged share of the canvas, four decimals; an empty canvas is identical to itself. */
export function similarityOf(changed: number, width: number, height: number): number {
  const total = width * height;
  if (total === 0) return 1;
  return Math.round((1 - changed / total) * 10_000) / 10_000;
}

export interface CaptureDiff {
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  readonly changedPercent: number;
  readonly changedBox: UiInspectBox | null;
  /** `1` is identical, `0` is every pixel changed. */
  readonly similarity: number;
  /** The diff picture: the faded `after` with every changed pixel red. */
  readonly diffPng: Uint8Array;
}

/** Two decoded captures, compared on the larger of their two canvases. */
export function compareRasters(before: Raster, after: Raster, threshold: number): CaptureDiff {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const a = padRaster(before, width, height);
  const b = padRaster(after, width, height);
  const result = diffPixels(a.pixels, b.pixels, width, height, threshold);
  return {
    width,
    height,
    changedPixels: result.changedPixels,
    changedPercent: changedPercent(result.changedPixels, width, height),
    changedBox: result.changedBox,
    similarity: similarityOf(result.changedPixels, width, height),
    diffPng: encodeImage({ width, height, pixels: result.diffRgba }),
  };
}

/** Two PNGs' bytes, decoded and compared. */
export async function compareCaptures(
  before: Uint8Array,
  after: Uint8Array,
  threshold: number,
): Promise<CaptureDiff> {
  const [a, b] = await Promise.all([decodeCapture(before), decodeCapture(after)]);
  return compareRasters(a, b, threshold);
}
