import { describe, expect, test } from 'bun:test';
import { renderPicture, responsiveImage, usableWidths } from './images';

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
