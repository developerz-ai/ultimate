// Single responsibility: the geometry and the pixels of a resize — output box, drawn size,
// colour parsing, resampling and the source-over composite. Every format shares this one
// scaler on purpose: a second one is a second place for a PWA icon to grow a grey halo.

import { imageUnsupported } from './errors';
import { assertPixelBudget, createRaster, type ImageSize, type Raster, rasterFrom } from './raster';

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

const COLOR_FIX =
  "pass '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' or 'transparent' — hex or transparent, " +
  'there are no named colours';

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

const HEX = /^#[0-9a-f]+$/;
/** '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' — the whole grammar, hash included. */
const HEX_LENGTHS: readonly number[] = [4, 5, 7, 9];

/** Hex or `transparent`, nothing else — one way to write a colour is one thing to get wrong. */
export function parseColor(value: string): readonly [number, number, number, number] {
  const text = value.toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (!HEX.test(text) || !HEX_LENGTHS.includes(text.length)) {
    throw imageUnsupported(`'${value}' is not a colour this pipeline understands`, COLOR_FIX, {
      value,
    });
  }
  const hex = text.slice(1);
  const short = hex.length < 6;
  const size = short ? 1 : 2;
  const channel = (index: number): number => {
    const part = hex.slice(index * size, index * size + size);
    return Number.parseInt(short ? part + part : part, 16);
  };
  const opaque = hex.length === 3 || hex.length === 6;
  return [channel(0), channel(1), channel(2), opaque ? 255 : channel(3)];
}

interface InnerBox {
  readonly pad: number;
  readonly inner: ImageSize;
}

function innerBox(box: ImageSize, padding: number): InnerBox {
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
  return { pad, inner };
}

interface AxisPlan {
  /** First contributing source index per target index. */
  readonly starts: Int32Array;
  /** `taps` normalised weights per target index, at `i * taps`. Unused taps are 0. */
  readonly weights: Float32Array;
  readonly taps: number;
}

/**
 * Area average when shrinking, bilinear when growing — chosen per axis. Nearest neighbour is
 * what makes a downscaled `srcset` variant look cheap, and this file feeds every one of them.
 */
function planAxis(source: number, target: number): AxisPlan {
  const ratio = source / target;
  if (target > source) {
    const starts = new Int32Array(target);
    const weights = new Float32Array(target * 2);
    for (let i = 0; i < target; i += 1) {
      const center = (i + 0.5) * ratio - 0.5;
      const left = Math.floor(center);
      const first = Math.min(Math.max(left, 0), source - 1);
      const second = Math.min(Math.max(left + 1, 0), source - 1);
      starts[i] = first;
      // Clamping at an edge collapses the pair; the surviving tap carries the whole weight.
      weights[i * 2] = second === first ? 1 : 1 - (center - left);
      weights[i * 2 + 1] = second === first ? 0 : center - left;
    }
    return { starts, weights, taps: 2 };
  }
  const taps = Math.ceil(ratio) + 1;
  const starts = new Int32Array(target);
  const weights = new Float32Array(target * taps);
  for (let i = 0; i < target; i += 1) {
    const from = i * ratio;
    const to = (i + 1) * ratio;
    const first = Math.min(Math.floor(from), source - 1);
    starts[i] = first;
    let total = 0;
    for (let k = 0; k < taps; k += 1) {
      const s = first + k;
      if (s >= source) break;
      const overlap = Math.min(to, s + 1) - Math.max(from, s);
      if (overlap <= 0) break;
      weights[i * taps + k] = overlap;
      total += overlap;
    }
    // Normalising is what keeps a partially covered edge column its own colour instead of
    // fading it toward zero, and what makes a solid image survive a downscale unchanged.
    if (total > 0) {
      for (let k = 0; k < taps; k += 1)
        weights[i * taps + k] = (weights[i * taps + k] ?? 0) / total;
    }
  }
  return { starts, weights, taps };
}

/** Averaging non-premultiplied RGBA bleeds a transparent pixel's colour into the visible edge. */
function premultiply(raster: Raster): Float32Array {
  const { pixels } = raster;
  const out = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    const f = a / 255;
    out[i] = (pixels[i] ?? 0) * f;
    out[i + 1] = (pixels[i + 1] ?? 0) * f;
    out[i + 2] = (pixels[i + 2] ?? 0) * f;
    out[i + 3] = a;
  }
  return out;
}

function unpremultiply(src: Float32Array, width: number, height: number): Raster {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = src[i + 3] ?? 0;
    if (a <= 0) continue;
    const f = 255 / a;
    pixels[i] = (src[i] ?? 0) * f;
    pixels[i + 1] = (src[i + 1] ?? 0) * f;
    pixels[i + 2] = (src[i + 2] ?? 0) * f;
    pixels[i + 3] = a;
  }
  return rasterFrom(width, height, pixels);
}

/**
 * The one weighted 4-channel sum both passes share. `base` + `step` are the only thing that
 * differs between horizontal and vertical, so there is a single accumulation to get right.
 */
function tapSum(
  src: Float32Array,
  out: Float32Array,
  q: number,
  base: number,
  step: number,
  plan: AxisPlan,
  i: number,
): void {
  const { starts, weights, taps } = plan;
  const from = base + (starts[i] ?? 0) * step;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let k = 0; k < taps; k += 1) {
    const w = weights[i * taps + k] ?? 0;
    // A zero weight is a tap the plan clamped away; skipping it is also what keeps the
    // read inside the buffer at the trailing edge.
    if (w === 0) continue;
    const p = from + k * step;
    r += (src[p] ?? 0) * w;
    g += (src[p + 1] ?? 0) * w;
    b += (src[p + 2] ?? 0) * w;
    a += (src[p + 3] ?? 0) * w;
  }
  out[q] = r;
  out[q + 1] = g;
  out[q + 2] = b;
  out[q + 3] = a;
}

function scaleX(src: Float32Array, sw: number, rows: number, dw: number, plan: AxisPlan) {
  const out = new Float32Array(dw * rows * 4);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      tapSum(src, out, (y * dw + x) * 4, y * sw * 4, 4, plan, x);
    }
  }
  return out;
}

function scaleY(src: Float32Array, cols: number, dh: number, plan: AxisPlan) {
  const out = new Float32Array(cols * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      tapSum(src, out, (y * cols + x) * 4, x * 4, cols * 4, plan, y);
    }
  }
  return out;
}

/** Separable: horizontal into scratch, then vertical. O(w·h·taps), never O(w·h·taps²). */
function resample(raster: Raster, size: ImageSize): Raster {
  if (raster.width === size.width && raster.height === size.height) return raster;
  assertPixelBudget(size.width, size.height, 'resize');
  const premul = premultiply(raster);
  const wide =
    size.width === raster.width
      ? premul
      : scaleX(premul, raster.width, raster.height, size.width, planAxis(raster.width, size.width));
  const tall =
    size.height === raster.height
      ? wide
      : scaleY(wide, size.width, size.height, planAxis(raster.height, size.height));
  return unpremultiply(tall, size.width, size.height);
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

/** Centres `art` in the inner area and clips to it — that clip is exactly the `cover` crop. */
function composite(canvas: Raster, art: Raster, pad: number, inner: ImageSize): void {
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
}

/** Box, background, resample, centre, composite — the whole resize, in that order. */
export function resizeRaster(raster: Raster, spec: ResizeSpec): Raster {
  const box = fitBox(raster, spec);
  const { pad, inner } = innerBox(box, spec.padding ?? 0);
  const unchanged =
    box.width === raster.width &&
    box.height === raster.height &&
    pad === 0 &&
    spec.background === undefined;
  if (unchanged) return raster;

  assertPixelBudget(box.width, box.height, 'resize');
  const drawn = scaledToFit(raster, inner, spec.fit ?? 'contain');
  const canvas = createRaster(box.width, box.height, 'resize');
  fill(canvas, parseColor(spec.background ?? 'transparent'));
  composite(canvas, resample(raster, drawn), pad, inner);
  return canvas;
}
