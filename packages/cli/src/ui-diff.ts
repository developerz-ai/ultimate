// The pixel half of `ui.diff`: two RGBA buffers of one size in, a count, a bounding box and a
// diff picture out. Pure — no file, no PNG container, no browser — so the rule a picture is judged
// by can be read in one screen and tested with four-byte images.
//
// The rule is per channel: a pixel is CHANGED when any of its four channels moved by more than
// `threshold * 255` between the two captures. There is deliberately NO anti-alias detection: a
// pixelmatch-style "this differs but a neighbour matches, so it is a font hinting artefact" pass
// is a heuristic a model then has to reason about, and the threshold already absorbs a one-level
// wobble. A capture that rendered a glyph one subpixel over is a change — an agent that judges it
// noise raises the threshold, which is a number in the call rather than a rule in this file.
//
// The diff picture is the `after` capture faded to a quarter over a light grey, with every changed
// pixel solid red. Faded rather than removed, so a red pixel is read against what it sits on.

import type { UiInspectBox } from '@ultimat3/mcp';

export interface PixelDiff {
  readonly changedPixels: number;
  /** The tightest box around every changed pixel, or `null` when nothing changed. */
  readonly changedBox: UiInspectBox | null;
  /** RGBA, the same size as the inputs: the faded `after` with changed pixels in `DIFF_RED`. */
  readonly diffRgba: Uint8ClampedArray;
}

const CHANNELS = 4;
/** Where an unchanged pixel lands: a quarter of its own colour over `FADE_GROUND`. */
export const FADE_ALPHA = 0.25;
export const FADE_GROUND = 230;
export const DIFF_RED = [255, 0, 0, 255] as const;

/** `threshold` in `[0, 1]` as a fraction of a channel's range; a delta strictly above it counts. */
export function channelLimit(threshold: number): number {
  return Math.min(1, Math.max(0, threshold)) * 255;
}

/** The faded value of one channel: `FADE_ALPHA` of it over the ground, rounded like a compositor. */
export const faded = (channel: number): number =>
  Math.round(channel * FADE_ALPHA + FADE_GROUND * (1 - FADE_ALPHA));

export function diffPixels(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
): PixelDiff {
  const limit = channelLimit(threshold);
  const diffRgba = new Uint8ClampedArray(width * height * CHANNELS);
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * CHANNELS;
      const changed =
        Math.abs((before[at] ?? 0) - (after[at] ?? 0)) > limit ||
        Math.abs((before[at + 1] ?? 0) - (after[at + 1] ?? 0)) > limit ||
        Math.abs((before[at + 2] ?? 0) - (after[at + 2] ?? 0)) > limit ||
        Math.abs((before[at + 3] ?? 0) - (after[at + 3] ?? 0)) > limit;
      if (changed) {
        changedPixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        diffRgba.set(DIFF_RED, at);
      } else {
        diffRgba[at] = faded(after[at] ?? 0);
        diffRgba[at + 1] = faded(after[at + 1] ?? 0);
        diffRgba[at + 2] = faded(after[at + 2] ?? 0);
        // Opaque: the fade is baked into the colour, so the picture reads the same on any viewer.
        diffRgba[at + 3] = 255;
      }
    }
  }
  const changedBox =
    changedPixels === 0
      ? null
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { changedPixels, changedBox, diffRgba };
}

/** `changedPixels / (width * height)` as a percentage with two decimals; `0` for an empty image. */
export function changedPercent(changedPixels: number, width: number, height: number): number {
  const total = width * height;
  if (total === 0) return 0;
  return Math.round((changedPixels / total) * 10_000) / 100;
}
