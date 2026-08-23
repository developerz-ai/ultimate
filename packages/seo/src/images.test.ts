import { describe, expect, test } from 'bun:test';
import type { ModernFormat } from './images';
import {
  IMAGE_QUERY_KEYS,
  parseImageQuery,
  renderPicture,
  responsiveImage,
  usableWidths,
} from './images';

const INPUT = { src: '/img/hero.jpg', width: 1200, height: 630, alt: 'Ultimate dashboard' };

describe('responsiveImage', () => {
  test('inlines intrinsic width/height and an aspect-ratio so CLS is 0', () => {
    const image = responsiveImage(INPUT);
    expect(image.img.width).toBe(1200);
    expect(image.img.height).toBe(630);
    expect(image.img.style).toContain('aspect-ratio:1200/630');
  });

  test('offers AVIF before WebP before the original', () => {
    const image = responsiveImage(INPUT);
    expect(image.sources.map((source) => source.type)).toEqual(['image/avif', 'image/webp']);
    expect(image.sources[0]?.srcset).toContain(`${IMAGE_QUERY_KEYS.format}=avif`);
    expect(image.img.srcset).not.toContain(`${IMAGE_QUERY_KEYS.format}=`);
  });

  test('a format the MIME table does not carry gets image/<format>, never a prototype member', () => {
    // `MIME_TYPES[format]` walked the prototype, so `formats: ['constructor']` rendered
    // `<source type="function Object() { [native code] }">`. The type attribute is the whole
    // point of a `<source>`: a browser reads it to decide whether to fetch the candidate.
    const image = responsiveImage(INPUT, {
      formats: ['constructor', 'toString'] as unknown as readonly ModernFormat[],
    });
    expect(image.sources.map((source) => source.type)).toEqual([
      'image/constructor',
      'image/toString',
    ]);
  });

  test('never upscales past the intrinsic width', () => {
    expect(usableWidths(640, [320, 640, 1280])).toEqual([320, 640]);
    expect(usableWidths(500, [320, 640])).toEqual([320, 500]);
    expect(responsiveImage(INPUT).img.srcset).not.toContain('1536w');
  });

  test('the no-srcset fallback is the LARGEST width, whatever order the caller gave', () => {
    // `widths[widths.length - 1]` was the largest only because `DEFAULT_WIDTHS` happens to
    // ascend; `usableWidths` preserves the caller's order, so a descending list handed every
    // browser without `srcset` support the SMALLEST variant of a full-width image.
    const descending = responsiveImage(INPUT, { widths: [1200, 640] });
    const ascending = responsiveImage(INPUT, { widths: [640, 1200] });

    expect(descending.img.src).toContain(`${IMAGE_QUERY_KEYS.width}=1200`);
    expect(descending.img.src).toBe(ascending.img.src);
    // The srcset still carries the caller's order — only the fallback is chosen by size.
    expect(descending.img.srcset).toBe('/img/hero.jpg?w=1200 1200w, /img/hero.jpg?w=640 640w');
  });

  test('the fallback never upscales past the intrinsic width', () => {
    // `usableWidths` drops 1920 and appends the intrinsic width, so the largest usable width
    // is 1200 — `Math.max` over the usable list, never over what the caller asked for.
    expect(responsiveImage(INPUT, { widths: [1920, 320] }).img.src).toContain(
      `${IMAGE_QUERY_KEYS.width}=1200`,
    );
  });

  test('a priority image is eager with high fetch priority', () => {
    const image = responsiveImage({ ...INPUT, priority: true });
    expect(image.img.loading).toBe('eager');
    expect(image.img.fetchpriority).toBe('high');
    expect(responsiveImage(INPUT).img.loading).toBe('lazy');
  });

  test('a blur placeholder becomes the background of the reserved box', () => {
    const image = responsiveImage({ ...INPUT, blurDataUrl: 'data:image/webp;base64,AAA' });
    expect(image.img.style).toContain('background-image:url(data:image/webp;base64,AAA)');
  });

  test('renderPicture emits width, height, and alt on the img', () => {
    const html = renderPicture(responsiveImage(INPUT));
    expect(html).toContain('<source type="image/avif"');
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="630"');
    expect(html).toContain('alt="Ultimate dashboard"');
  });
});

/** `toBeUltimateError` reads a value, and every rejection here throws synchronously. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('parseImageQuery', () => {
  test('round-trips the exact width and format a minted srcset URL carries', () => {
    const image = responsiveImage(INPUT);
    const firstEntry = image.sources[0]?.srcset.split(', ')[0]?.split(' ')[0] ?? '';
    const url = new URL(firstEntry, 'https://x.test');
    expect(parseImageQuery(url.searchParams)).toEqual({ width: 320, format: 'avif' });
  });

  test('a URL with none of the three keys is a plain asset read, not a transform', () => {
    expect(parseImageQuery(new URL('https://x.test/img/hero.jpg').searchParams)).toBeNull();
  });

  test('accepts width, format and quality together', () => {
    const params = new URLSearchParams({
      [IMAGE_QUERY_KEYS.width]: '640',
      [IMAGE_QUERY_KEYS.format]: 'webp',
      [IMAGE_QUERY_KEYS.quality]: '75',
    });
    expect(parseImageQuery(params)).toEqual({ width: 640, format: 'webp', quality: 75 });
  });

  test('an empty, non-numeric, zero, negative or fractional width throws', () => {
    for (const bad of ['', 'abc', '0', '-5', '12.5']) {
      const error = caught(() =>
        parseImageQuery(new URLSearchParams({ [IMAGE_QUERY_KEYS.width]: bad })),
      );
      expect(error).toBeUltimateError('X_IMAGE_QUERY_INVALID');
    }
  });

  /**
   * Digits all the way down still parse: `Number.parseInt('9'.repeat(400))` is `Infinity`, which
   * satisfies every "is it a positive integer" test and then reaches the driver as a width no
   * pipeline can allocate. The refusal has to be a range check, not a shape check.
   */
  test('a width too long to be a number throws instead of parsing to Infinity', () => {
    for (const key of [IMAGE_QUERY_KEYS.width, IMAGE_QUERY_KEYS.quality]) {
      const error = caught(() =>
        parseImageQuery(new URLSearchParams({ [key]: '9'.repeat(400) })),
      ) as { code?: string; meta?: Record<string, unknown> };
      expect(error).toBeUltimateError('X_IMAGE_QUERY_INVALID');
      expect(error.meta?.['param']).toBe(key);
    }
  });

  test('a quality above 100, or otherwise unusable, throws the same code', () => {
    for (const bad of ['101', '1000', 'abc', '0', '-5']) {
      const error = caught(() =>
        parseImageQuery(new URLSearchParams({ [IMAGE_QUERY_KEYS.quality]: bad })),
      );
      expect(error).toBeUltimateError('X_IMAGE_QUERY_INVALID');
    }
  });

  test('a present but empty format throws', () => {
    const error = caught(() =>
      parseImageQuery(new URLSearchParams({ [IMAGE_QUERY_KEYS.format]: '' })),
    );
    expect(error).toBeUltimateError('X_IMAGE_QUERY_INVALID');
  });

  test('the fix line names a usable value, not just the code', () => {
    const error = caught(() =>
      parseImageQuery(new URLSearchParams({ [IMAGE_QUERY_KEYS.width]: '0' })),
    ) as {
      fix?: string;
      cause?: string;
    };
    expect(error.cause).toContain(`${IMAGE_QUERY_KEYS.width}=0`);
    expect(error.fix).toContain(`${IMAGE_QUERY_KEYS.width}=640`);
  });

  test('a format naming no real format is not rejected here — the driver owns that refusal', () => {
    expect(parseImageQuery(new URLSearchParams({ [IMAGE_QUERY_KEYS.format]: 'potato' }))).toEqual({
      format: 'potato',
    });
  });
});

describe('the width ceiling', () => {
  test('a width past the ceiling is refused, not handed to the encoder', () => {
    // A safe integer is not a servable width: this clears the digits test and the safe-integer
    // gate, and on a caching surface each distinct width also mints a stored object.
    expect(() => parseImageQuery(new URLSearchParams('w=99999999'))).toThrow(/8192 or less/);
    expect(() => parseImageQuery(new URLSearchParams('w=8193'))).toThrow(/8192 or less/);
  });

  test('the ceiling itself, and everything under it, still parses', () => {
    expect(parseImageQuery(new URLSearchParams('w=8192'))).toEqual({ width: 8192 });
    expect(parseImageQuery(new URLSearchParams('w=1920'))).toEqual({ width: 1920 });
  });
});

/**
 * The same rule `DESCRIPTION_MIN_LENGTH` and `checkBudgets` were deleted under, applied to a
 * helper: `extensionOf` was exported from `index.ts` with no caller anywhere in the tree — not in
 * this package, not in `render`, `cli` or either tracked app. A published symbol nothing calls is
 * a second way to answer a question this package does not ask (`parseImageQuery` reads the FORMAT
 * off the query, never off the path), and `meta.test.ts` pins the exported bounds for the reason
 * this pins the barrel: re-adding one is a failing test, not a review comment.
 */
describe('the barrel carries no callerless helper', () => {
  test('extensionOf is gone from the public surface', async () => {
    const exported = Object.keys(await import('./index'));
    expect(exported).not.toContain('extensionOf');
    // The control: this test reads a real barrel, not an empty object it mistook for one.
    expect(exported).toContain('parseImageQuery');
  });
});
