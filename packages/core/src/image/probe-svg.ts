// Single responsibility: reading an SVG's intrinsic box out of its TEXT. Every other format
// declares its size in fixed header bytes; SVG declares it in markup, which is a different job
// with a different failure mode (untrusted text, catastrophic backtracking, percentages that are
// not pixels) — and mixing the two into one file is what made `probe.ts` two files' worth.

import { imageDecodeFailed } from './errors';
import type { ImageSize } from './raster';

/** Only the prologue and the root tag carry the box; an SVG body can be megabytes. */
const SVG_HEAD_BYTES = 65_536;
/** `TextDecoder` already strips a leading BOM, so only real whitespace is left to skip. */
const SVG_WHITESPACE = ' \t\n\r\f\v';
const SVG_PIXELS = /^\s*(\d*\.?\d+)(?:px)?\s*$/i;

const svgHead = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes.subarray(0, SVG_HEAD_BYTES));

/** The only things allowed before the root element: a comment, an XML declaration, a DOCTYPE. */
const SVG_PROLOGUE: readonly (readonly [string, string])[] = [
  ['<!--', '-->'],
  ['<?', '?>'],
  ['<!', '>'],
];

/**
 * Index of the root `<svg`, or -1. Hand-walked rather than matched with a regex: the input is
 * untrusted, and an alternation of lazy groups backtracks catastrophically on a near-miss.
 */
function svgRootIndex(text: string): number {
  let at = 0;
  while (at < text.length) {
    if (SVG_WHITESPACE.includes(text[at] ?? '')) {
      at += 1;
      continue;
    }
    if (text.startsWith('<svg', at)) return at;
    const prologue = SVG_PROLOGUE.find(([open]) => text.startsWith(open, at));
    if (prologue === undefined) return -1;
    const close = text.indexOf(prologue[1], at);
    at = close === -1 ? text.length : close + prologue[1].length;
  }
  return -1;
}

/** The sniff's other half: a `<` opened the file, but only a root `<svg` makes it an image. */
export const hasSvgRoot = (bytes: Uint8Array): boolean => svgRootIndex(svgHead(bytes)) >= 0;

const svgAttribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*['"]([^'"]*)['"]`, 'i').exec(tag)?.[1];

/** A percentage is a share of a viewport, not a pixel size — it cannot reserve a box. */
function svgPixels(value: string | undefined): number | null {
  if (value === undefined) return null;
  const matched = SVG_PIXELS.exec(value);
  const pixels = Number(matched?.[1] ?? Number.NaN);
  return Number.isFinite(pixels) && pixels > 0 ? Math.round(pixels) : null;
}

function svgViewBox(tag: string): ImageSize | null {
  const raw = svgAttribute(tag, 'viewBox');
  if (raw === undefined) return null;
  const parts = raw.trim().split(/[\s,]+/);
  const width = Math.round(Number(parts[2] ?? ''));
  const height = Math.round(Number(parts[3] ?? ''));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width, height };
}

/** Pixel `width`/`height` first, then the `viewBox` — the order a browser resolves them in. */
export function probeSvg(bytes: Uint8Array): ImageSize {
  const text = svgHead(bytes);
  const start = svgRootIndex(text);
  const closing = text.indexOf('>', start);
  const tag = text.slice(start, closing === -1 ? text.length : closing + 1);
  const width = svgPixels(svgAttribute(tag, 'width'));
  const height = svgPixels(svgAttribute(tag, 'height'));
  if (width !== null && height !== null) return { width, height };
  const viewBox = svgViewBox(tag);
  if (viewBox !== null) return viewBox;
  throw imageDecodeFailed(
    'SVG declares no intrinsic size: its root tag carries no pixel `width` and `height`, and ' +
      'no usable `viewBox`',
    { format: 'svg' },
  );
}
