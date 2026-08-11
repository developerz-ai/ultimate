import { describe, expect, test } from 'bun:test';
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
    expect(image.sources[0]?.srcset).toContain('f=avif');
    expect(image.img.srcset).not.toContain('f=');
  });

  test('never upscales past the intrinsic width', () => {
    expect(usableWidths(640, [320, 640, 1280])).toEqual([320, 640]);
    expect(usableWidths(500, [320, 640])).toEqual([320, 500]);
    expect(responsiveImage(INPUT).img.srcset).not.toContain('1536w');
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
      const error = caught(() => parseImageQuery(new URLSearchParams({ w: bad })));
      expect(error).toBeUltimateError('X_IMAGE_QUERY_INVALID');
    }
  });

  test('a quality above 100, or otherwise unusable, throws the same code', () => {
    for (const bad of ['101', '1000', 'abc', '0', '-5']) {
      const error = caught(() => parseImageQuery(new URLSearchParams({ q: bad })));
      expect(error).toBeUltimateError('X_IMAGE_QUERY_INVALID');
    }
  });

  test('a present but empty format throws', () => {
    const error = caught(() => parseImageQuery(new URLSearchParams({ f: '' })));
    expect(error).toBeUltimateError('X_IMAGE_QUERY_INVALID');
  });

  test('the fix line names a usable value, not just the code', () => {
    const error = caught(() => parseImageQuery(new URLSearchParams({ w: '0' }))) as {
      fix?: string;
      cause?: string;
    };
    expect(error.cause).toContain('w=0');
    expect(error.fix).toContain(`${IMAGE_QUERY_KEYS.width}=640`);
  });

  test('a format naming no real format is not rejected here — the driver owns that refusal', () => {
    expect(parseImageQuery(new URLSearchParams({ f: 'potato' }))).toEqual({ format: 'potato' });
  });
});
