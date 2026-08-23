// Pure srcset core behind <Image>. Split out so the descriptor rules — one kind
// per set, ascending, no duplicates — are testable without a renderer, and so a
// malformed variant list fails where it is written instead of shipping a srcset
// the browser silently ignores.

import { invalidValueError } from '../errors';

/**
 * One rendition of an image. Exactly one of `width` (emits a `w` descriptor) or
 * `density` (an `x` descriptor): HTML forbids mixing the two in one srcset.
 */
export interface ImageVariant {
  src: string;
  /** Intrinsic width in CSS pixels. Pairs with `sizes`. */
  width?: number | undefined;
  /** Device pixel ratio this rendition targets. Use when the box is fixed. */
  density?: number | undefined;
}

/** What `priority` resolves to on the element — never decided at the call site. */
export interface ImageLoadingHints {
  loading: 'eager' | 'lazy';
  fetchpriority: 'high' | 'auto';
  decoding: 'async';
}

/** Intrinsic dimensions to inline. Both, or the browser has no ratio to reserve. */
export interface ImageBox {
  width: number;
  height: number;
}

interface Candidate {
  src: string;
  kind: 'w' | 'x';
  value: number;
}

/**
 * The `srcset` attribute for a variant list, ordered ascending so the markup is
 * byte-stable whatever order the caller built the list in. `undefined` for an
 * empty list — the component omits the attribute rather than emitting an empty one.
 */
export function srcsetFor(variants: readonly ImageVariant[] | undefined): string | undefined {
  if (variants === undefined || variants.length === 0) return undefined;

  const candidates = variants.map(toCandidate);
  if (new Set(candidates.map((candidate) => candidate.kind)).size > 1) {
    throw invalidValueError(
      'Image',
      variants,
      'a variant list of one descriptor kind — every variant with width, or every variant with density',
    );
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const descriptor = descriptorOf(candidate);
    if (seen.has(descriptor)) {
      throw invalidValueError(
        'Image',
        variants,
        `a variant list with distinct descriptors — ${descriptor} appears twice`,
      );
    }
    seen.add(descriptor);
  }

  return [...candidates]
    .sort((a, b) => a.value - b.value)
    .map((candidate) => `${candidate.src} ${descriptorOf(candidate)}`)
    .join(', ');
}

/**
 * `priority` is the only knob: eager + high priority for the LCP image, lazy +
 * auto for every other one. Decoding is always async — a sync decode blocks paint.
 */
export function loadingHints(priority: boolean | undefined): ImageLoadingHints {
  return priority === true
    ? { loading: 'eager', fetchpriority: 'high', decoding: 'async' }
    : { loading: 'lazy', fetchpriority: 'auto', decoding: 'async' };
}

/**
 * Both dimensions or neither: one alone gives the browser no aspect ratio to
 * reserve, which is the layout shift <Image> exists to prevent.
 */
export function boxFor(
  width: number | undefined,
  height: number | undefined,
): ImageBox | undefined {
  if (width === undefined && height === undefined) return undefined;
  if (width === undefined || height === undefined) {
    throw invalidValueError(
      'Image',
      { width, height },
      'both width and height, or neither — one alone reserves no aspect ratio',
    );
  }
  assertPixels(width);
  assertPixels(height);
  return { width, height };
}

/**
 * A `src` with real content once whitespace is trimmed. Shared by the primary `src` prop and
 * every variant `src`: an empty or blank one emits a broken `<img>` or a srcset entry the
 * browser silently drops, so both paths reject it the same way instead of one staying permissive.
 */
export function assertNonEmptySrc(kind: string, value: unknown, src: string): string {
  const trimmed = src.trim();
  if (trimmed === '') {
    throw invalidValueError(kind, value, 'a non-empty src');
  }
  return trimmed;
}

/**
 * `srcset` is a comma-separated list whose entries are split on WHITESPACE — so the two characters
 * a src may not carry are whitespace anywhere and a comma at either end. Trimming the ends is not
 * enough: `'/my file.webp 800w'` parses as the URL `/my` with the descriptor `file.webp`, which is
 * not a descriptor, so the candidate is dropped and the `<img>` silently falls back to `src`. An
 * INTERIOR comma is fine and is deliberately allowed — the parser reads a URL up to the first
 * whitespace, so `/img/a,b.webp` round-trips.
 */
const SRCSET_UNSAFE = /\s|^,|,$/;

function toCandidate(variant: ImageVariant): Candidate {
  const src = assertNonEmptySrc('Image', variant, variant.src);
  if (SRCSET_UNSAFE.test(src)) {
    throw invalidValueError(
      'Image',
      variant,
      'a variant src with no whitespace and no leading or trailing comma — srcset splits on both, so such a src is dropped by the browser rather than reported',
    );
  }

  const width = variant.width;
  const density = variant.density;
  if ((width === undefined) === (density === undefined)) {
    throw invalidValueError(
      'Image',
      variant,
      'a variant with exactly one of width (a w descriptor) or density (an x descriptor)',
    );
  }

  if (width !== undefined) {
    assertPixels(width);
    return { src, kind: 'w', value: width };
  }
  if (density === undefined || !Number.isFinite(density) || density <= 0) {
    throw invalidValueError('Image', variant, 'a positive density, such as 1, 1.5 or 2');
  }
  return { src, kind: 'x', value: density };
}

function descriptorOf(candidate: Candidate): string {
  return `${candidate.value}${candidate.kind}`;
}

function assertPixels(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidValueError('Image', value, 'a positive whole number of CSS pixels');
  }
}
