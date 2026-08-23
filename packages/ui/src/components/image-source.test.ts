import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES, UiError } from '../errors';
import type { ImageLoadingHints } from './image-source';
import { assertNonEmptySrc, boxFor, loadingHints, srcsetFor } from './image-source';

/**
 * The thrown UiError itself, so a test can assert on `code` and `cause` together. Anything else
 * — no throw, or a throw that is not a UiError — is a real, unconditional test failure via
 * `expect.unreachable` rather than a bare `Error` or a fabricated `{ code, cause }` shape that
 * would let a broken implementation pass by accident.
 */
function rejected(run: () => unknown): UiError {
  try {
    run();
  } catch (error) {
    if (error instanceof UiError) return error;
  }
  return expect.unreachable('expected a UiError');
}

describe('srcsetFor', () => {
  test('no variants means no attribute, not an empty one', () => {
    expect(srcsetFor(undefined)).toBeUndefined();
    expect(srcsetFor([])).toBeUndefined();
  });

  test('width variants emit w descriptors, ascending whatever order they arrive in', () => {
    expect(
      srcsetFor([
        { src: '/hero-1280.avif', width: 1280 },
        { src: '/hero-640.avif', width: 640 },
        { src: '/hero-960.avif', width: 960 },
      ]),
    ).toBe('/hero-640.avif 640w, /hero-960.avif 960w, /hero-1280.avif 1280w');
  });

  test('density variants emit x descriptors, fractions kept, integers not padded', () => {
    expect(
      srcsetFor([
        { src: '/logo@2x.png', density: 2 },
        { src: '/logo.png', density: 1 },
        { src: '/logo@1.5x.png', density: 1.5 },
      ]),
    ).toBe('/logo.png 1x, /logo@1.5x.png 1.5x, /logo@2x.png 2x');
  });

  test('a single variant still carries its descriptor', () => {
    expect(srcsetFor([{ src: '/a.webp', width: 800 }])).toBe('/a.webp 800w');
  });

  test('surrounding whitespace is trimmed so the comma-separated list stays parseable', () => {
    expect(srcsetFor([{ src: '  /a.webp\n', width: 800 }])).toBe('/a.webp 800w');
  });

  /**
   * `srcset` is a COMMA-separated list of `<url> <descriptor>` pairs, split on whitespace — so a
   * src carrying either character is not a src the browser can read back. Trimming the ends, which
   * is all this file did, leaves the middle: `/my file.webp 800w` parses as the URL `/my` with the
   * descriptor `file.webp`, which is not a descriptor, so the candidate is dropped in silence and
   * the `<img>` falls back to `src`. That is exactly the "srcset the browser silently ignores"
   * this module's own header says it exists to prevent.
   */
  test.each([
    ['interior whitespace', '/my file.webp'],
    ['a tab', '/a\tb.webp'],
    ['a trailing comma, which the parser strips', '/a.webp,'],
    ['a leading comma', ',/a.webp'],
  ])('a variant src carrying %s is rejected, not emitted', (_why, src) => {
    const error = rejected(() => srcsetFor([{ src, width: 800 }]));
    expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
    expect(String(error.cause)).toContain('srcset');
  });

  /** …and an interior comma is NOT rejected: the parser reads a URL up to whitespace, so a path
   *  with a comma in it round-trips. Refusing it would be a rule this microsyntax does not have. */
  test('an interior comma is left alone, because srcset splits on whitespace first', () => {
    expect(srcsetFor([{ src: '/img/a,b.webp', width: 800 }])).toBe('/img/a,b.webp 800w');
  });

  test('mixing w and x descriptors is rejected — HTML forbids it', () => {
    const error = rejected(() =>
      srcsetFor([
        { src: '/a.webp', width: 800 },
        { src: '/a@2x.webp', density: 2 },
      ]),
    );
    expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
    expect(String(error.cause)).toContain('one descriptor kind');
  });

  test('a repeated descriptor is rejected rather than silently shadowed', () => {
    const error = rejected(() =>
      srcsetFor([
        { src: '/a.webp', width: 800 },
        { src: '/b.webp', width: 800 },
      ]),
    );
    expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
    expect(String(error.cause)).toContain('800w appears twice');
  });

  test('a variant with no descriptor is rejected', () => {
    expect(rejected(() => srcsetFor([{ src: '/a.webp' }])).code).toBe(UI_ERROR_CODES.invalidValue);
  });

  test('a variant with both descriptors is rejected', () => {
    const error = rejected(() => srcsetFor([{ src: '/a.webp', width: 800, density: 2 }]));
    expect(String(error.cause)).toContain('exactly one of width');
  });

  test('a fractional or non-positive width is rejected', () => {
    expect(rejected(() => srcsetFor([{ src: '/a.webp', width: 800.5 }])).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
    expect(rejected(() => srcsetFor([{ src: '/a.webp', width: 0 }])).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
  });

  test('a non-positive or non-finite density is rejected', () => {
    expect(rejected(() => srcsetFor([{ src: '/a.webp', density: 0 }])).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
    expect(rejected(() => srcsetFor([{ src: '/a.webp', density: Number.NaN }])).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
  });

  test('an empty src is rejected', () => {
    const error = rejected(() => srcsetFor([{ src: '   ', width: 800 }]));
    expect(String(error.cause)).toContain('non-empty src');
  });
});

describe('loadingHints', () => {
  test('priority is the LCP image: eager, high, async', () => {
    expect(loadingHints(true)).toEqual({
      loading: 'eager',
      fetchpriority: 'high',
      decoding: 'async',
    });
  });

  test('everything else defers: lazy, auto, async', () => {
    // Annotated, not inferred: a bare literal widens to `string` and would still `toEqual`
    // a hint object whose union members had drifted.
    const lazy: ImageLoadingHints = { loading: 'lazy', fetchpriority: 'auto', decoding: 'async' };
    expect(loadingHints(false)).toEqual(lazy);
    expect(loadingHints(undefined)).toEqual(lazy);
  });
});

describe('boxFor', () => {
  test('both dimensions are inlined as given', () => {
    expect(boxFor(1240, 720)).toEqual({ width: 1240, height: 720 });
  });

  test('neither dimension is a valid choice — nothing is fabricated', () => {
    expect(boxFor(undefined, undefined)).toBeUndefined();
  });

  test('one dimension alone is rejected: it reserves no ratio', () => {
    expect(rejected(() => boxFor(1240, undefined)).code).toBe(UI_ERROR_CODES.invalidValue);
    const error = rejected(() => boxFor(undefined, 720));
    expect(String(error.cause)).toContain('both width and height');
  });

  test('a fractional or non-positive dimension is rejected', () => {
    expect(rejected(() => boxFor(1240.5, 720)).code).toBe(UI_ERROR_CODES.invalidValue);
    expect(rejected(() => boxFor(1240, -720)).code).toBe(UI_ERROR_CODES.invalidValue);
  });
});

describe('assertNonEmptySrc', () => {
  test('a src with content is trimmed and returned', () => {
    expect(assertNonEmptySrc('Image', '  /a.webp  ', '  /a.webp  ')).toBe('/a.webp');
  });

  test('an empty src is rejected — it would emit a broken <img src="">', () => {
    const error = rejected(() => assertNonEmptySrc('Image', '', ''));
    expect(error.code).toBe(UI_ERROR_CODES.invalidValue);
    expect(String(error.cause)).toContain('non-empty src');
  });

  test('a whitespace-only src is rejected — trimming it would leave nothing', () => {
    expect(rejected(() => assertNonEmptySrc('Image', '   ', '   ')).code).toBe(
      UI_ERROR_CODES.invalidValue,
    );
  });
});
