// Single responsibility: the GEOMETRY of a resize — output box, padded inner area, drawn size —
// and the source-over composite that places the drawn artwork on it. `Bun.Image` resamples but
// cannot letterbox, pad or crop, so this is the half of a transform it does not do; keeping the
// arithmetic here is also what lets a caller ask for the box before any pixel exists.

import { parseColor } from './color';
import { imageUnsupported } from './errors';
import { assertPixelBudget, createRaster, type ImageSize, type Raster } from './raster';

export type ImageFit = 'cover' | 'contain';

export interface ResizeSpec {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** Default 'contain'. */
  readonly fit?: ImageFit | undefined;
  /** Fraction of the shorter OUTPUT edge left empty on every side. `0 <= padding < 0.5`. */
  readonly padding?: number | undefined;
  /** '#rgb' | '#rgba' | '#rrggbb' | '#rrggbbaa' | 'transparent'. Default transparent. */
  readonly background?: string | undefined;
}

function assertDimension(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw imageUnsupported(
      `resize ${field} is ${value}, which is not a whole number of pixels above zero`,
      `pass an integer ${field} of 1 or more, or omit it to derive it from the source`,
      { field, value },
    );
  }
}

/**
 * The output CANVAS size. A single-axis request clamps to the source: asking for `width: 2000`
 * of a 400px original must not invent 1600 pixels of blur, it must hand back the 400.
 */
export function fitBox(source: ImageSize, spec: ResizeSpec): ImageSize {
  const { width, height } = spec;
  if (width !== undefined) assertDimension(width, 'width');
  if (height !== undefined) assertDimension(height, 'height');
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) {
    const w = Math.min(width, source.width);
    return { width: w, height: Math.max(1, Math.round((w * source.height) / source.width)) };
  }
  if (height !== undefined) {
    const h = Math.min(height, source.height);
    return { width: Math.max(1, Math.round((h * source.width) / source.height)), height: h };
  }
  return { width: source.width, height: source.height };
}

/** The size the source is DRAWN at inside `box` — no letterbox, no crop maths. May upscale. */
export function scaledToFit(source: ImageSize, box: ImageSize, fit: ImageFit): ImageSize {
  const x = box.width / source.width;
  const y = box.height / source.height;
  const scale = fit === 'cover' ? Math.max(x, y) : Math.min(x, y);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/** The whole plan for one transform, decided before a pixel is touched. */
export interface Layout {
  /** The output canvas. */
  readonly box: ImageSize;
  /** Pixels of padding on each edge. */
  readonly pad: number;
  /** The area inside the padding the artwork may occupy. */
  readonly inner: ImageSize;
  /** What the source is resampled to before it is placed. */
  readonly drawn: ImageSize;
  /** Parsed once, here, so an unspellable colour is refused before any pixel is produced. */
  readonly background: readonly [number, number, number, number];
  /** False when `drawn` IS the box and nothing shows through — the resampler's output is the answer. */
  readonly needsCanvas: boolean;
}

export function layOut(source: ImageSize, spec: ResizeSpec): Layout {
  const box = fitBox(source, spec);
  assertPixelBudget(box.width, box.height, 'resize');
  const padding = spec.padding ?? 0;
  if (!Number.isFinite(padding) || padding < 0 || padding >= 0.5) {
    throw imageUnsupported(
      `resize padding is ${padding}, outside the 0 <= padding < 0.5 range`,
      'pass a fraction of the shorter output edge, e.g. 0.1 for a 10% border on every side',
      { padding },
    );
  }
  const pad = Math.round(Math.min(box.width, box.height) * padding);
  const inner = { width: box.width - 2 * pad, height: box.height - 2 * pad };
  if (inner.width < 1 || inner.height < 1) {
    throw imageUnsupported(
      `padding ${padding} leaves no room inside a ${box.width}x${box.height} output`,
      'lower the padding or raise the requested width and height',
      { padding, pad, width: box.width, height: box.height },
    );
  }
  const drawn = scaledToFit(source, inner, spec.fit ?? 'contain');
  // Parsed even when the fast path will not use it: 'chartreuse' must be refused whether or not
  // the geometry happens to hide the colour, or the rejection depends on the source's dimensions.
  const background = parseColor(spec.background ?? 'transparent');
  // An opaque background still shows THROUGH a source with alpha, so it needs the canvas even at
  // full bleed. A transparent one does not, and skipping it keeps a plain `srcset` variant out of
  // the RGBA round trip entirely.
  const needsCanvas =
    drawn.width !== box.width || drawn.height !== box.height || background[3] !== 0;
  return { box, pad, inner, drawn, background, needsCanvas };
}

function fill(canvas: Raster, color: readonly [number, number, number, number]): void {
  const [r, g, b, a] = color;
  // A zero-alpha background is canonicalised to all-zero, matching the composite's own
  // `outA === 0 -> outC = 0`: '#ff000000' and 'transparent' must not produce different bytes.
  if (a === 0) return;
  const { pixels } = canvas;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }
}

/** Source-over. `outA === 0` means every contributor was transparent — the colour is nothing. */
function blend(dst: Uint8ClampedArray, d: number, s: Uint8ClampedArray, p: number): void {
  const sa = s[p + 3] ?? 0;
  if (sa === 0) return;
  const da = dst[d + 3] ?? 0;
  if (sa === 255 || da === 0) {
    dst[d] = s[p] ?? 0;
    dst[d + 1] = s[p + 1] ?? 0;
    dst[d + 2] = s[p + 2] ?? 0;
    dst[d + 3] = sa;
    return;
  }
  const sf = sa / 255;
  const df = (da / 255) * (1 - sf);
  const outA = sf + df;
  dst[d] = ((s[p] ?? 0) * sf + (dst[d] ?? 0) * df) / outA;
  dst[d + 1] = ((s[p + 1] ?? 0) * sf + (dst[d + 1] ?? 0) * df) / outA;
  dst[d + 2] = ((s[p + 2] ?? 0) * sf + (dst[d + 2] ?? 0) * df) / outA;
  dst[d + 3] = outA * 255;
}

/**
 * The artwork, centred in the inner area and clipped to it — that clip is exactly the `cover`
 * crop, so one blit serves both fits.
 */
export function composeOnto(art: Raster, layout: Layout): Raster {
  const { box, pad, inner } = layout;
  const canvas = createRaster(box.width, box.height, 'resize');
  fill(canvas, layout.background);
  const ox = pad + Math.round((inner.width - art.width) / 2);
  const oy = pad + Math.round((inner.height - art.height) / 2);
  const x1 = Math.min(pad + inner.width, ox + art.width);
  const y1 = Math.min(pad + inner.height, oy + art.height);
  for (let y = Math.max(pad, oy); y < y1; y += 1) {
    for (let x = Math.max(pad, ox); x < x1; x += 1) {
      blend(
        canvas.pixels,
        (y * canvas.width + x) * 4,
        art.pixels,
        ((y - oy) * art.width + (x - ox)) * 4,
      );
    }
  }
  return canvas;
}
