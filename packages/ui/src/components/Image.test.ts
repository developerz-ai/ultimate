// `<Image>`'s wiring: the rules live in `image-source.ts` (tested there); this asks whether the
// component asks them and whether the answers reach the element — the loading hints, the reserved
// box it may never omit, and the AVIF/WebP `<source>`s in front of the fallback.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe } from '../jsx-probe';
import { Image } from './Image';

const BOX = { width: 620, height: 320 } as const;

describe('Image', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('an image with no reserved box is refused — neither size nor ratio shifts the layout', () => {
    expect(() => renderNodes(Image, { src: '/a.png', alt: 'A' })).toThrow(
      expect.objectContaining({ code: 'X_UI_INVALID_VALUE' }),
    );
    // One dimension alone reserves no ratio either.
    expect(() => renderNodes(Image, { src: '/a.png', alt: 'A', width: 620 })).toThrow(
      expect.objectContaining({ code: 'X_UI_INVALID_VALUE' }),
    );
    // Two answers to one question.
    expect(() =>
      renderNodes(Image, { src: '/a.png', alt: 'A', ...BOX, aspectRatio: '16 / 9' }),
    ).toThrow(expect.objectContaining({ code: 'X_UI_INVALID_VALUE' }));
    expect(() => renderNodes(Image, { src: '/a.png', alt: 'A', aspectRatio: '0 / 9' })).toThrow(
      expect.objectContaining({ code: 'X_UI_INVALID_VALUE' }),
    );
  });

  test('is lazy and low priority unless it is the LCP image', () => {
    const img = one(byTag(renderNodes(Image, { src: '/a.png', alt: 'A', ...BOX }), 'img'), 'img');
    expect(img.props['loading']).toBe('lazy');
    expect(img.props['fetchpriority']).toBe('auto');
    expect(img.props['decoding']).toBe('async');
  });

  test('priority is fetchpriority="high" and never lazy — eager alone still queues', () => {
    const img = one(
      byTag(renderNodes(Image, { src: '/a.png', alt: 'A', priority: true, ...BOX }), 'img'),
      'img',
    );
    expect(img.props['loading']).toBe('eager');
    expect(img.props['fetchpriority']).toBe('high');
  });

  test('both dimensions reach the element and the ratio, so the box survives styling', () => {
    const img = one(byTag(renderNodes(Image, { src: '/a.png', alt: 'A', ...BOX }), 'img'), 'img');
    expect(img.props['width']).toBe(620);
    expect(img.props['height']).toBe(320);
    expect(img.props['style']).toEqual({ '--image-ratio': '620 / 320' });
  });

  test('an aspectRatio alone reserves the box without inventing a size', () => {
    const img = one(
      byTag(renderNodes(Image, { src: '/a.png', alt: 'A', aspectRatio: '16 / 9' }), 'img'),
      'img',
    );
    expect(img.props['width']).toBeUndefined();
    expect(img.props['style']).toEqual({ '--image-ratio': '16 / 9' });
  });

  test('the srcset is the derived one, ascending, whatever order the caller wrote', () => {
    const img = one(
      byTag(
        renderNodes(Image, {
          src: '/a.png',
          alt: 'A',
          ...BOX,
          sizes: '100vw',
          variants: [
            { src: '/a-1200.png', width: 1200 },
            { src: '/a-600.png', width: 600 },
          ],
        }),
        'img',
      ),
      'img',
    );
    expect(img.props['srcset']).toBe('/a-600.png 600w, /a-1200.png 1200w');
    expect(img.props['sizes']).toBe('100vw');
  });

  test('with no sources it is a bare <img>, never an empty <picture>', () => {
    expect(byTag(renderNodes(Image, { src: '/a.png', alt: 'A', ...BOX }), 'picture')).toEqual([]);
  });

  test('sources become a <picture>: AVIF, then WebP, then the fallback <img>', () => {
    const nodes = renderNodes(Image, {
      src: '/hero.jpg',
      alt: 'Hero',
      ...BOX,
      priority: true,
      sizes: '100vw',
      sources: {
        webp: [
          { src: '/assets/hero-1280.abcdef01.webp', width: 1280 },
          { src: '/assets/hero-640.abcdef02.webp', width: 640 },
        ],
        avif: [{ src: '/assets/hero-640.abcdef03.avif', width: 640 }],
      },
    });
    one(byTag(nodes, 'picture'), 'picture');
    const sources = byTag(nodes, 'source');
    expect(sources.map((node) => node.props['type'])).toEqual(['image/avif', 'image/webp']);
    expect(sources[1]?.props['srcset']).toBe(
      '/assets/hero-640.abcdef02.webp 640w, /assets/hero-1280.abcdef01.webp 1280w',
    );
    expect(sources.every((node) => node.props['sizes'] === '100vw')).toBe(true);
    const img = one(byTag(nodes, 'img'), 'img');
    expect(img.props['src']).toBe('/hero.jpg');
    expect(img.props['fetchpriority']).toBe('high');
  });

  test('an empty src is refused where it is written, not shipped as a broken element', () => {
    expect(() => renderNodes(Image, { src: '   ', alt: 'A', ...BOX })).toThrow(
      expect.objectContaining({ code: 'X_UI_INVALID_VALUE' }),
    );
  });
});
