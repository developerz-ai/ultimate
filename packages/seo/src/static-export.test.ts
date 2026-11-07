// While a static export renders, an image variant and a captured card are FILES the export names;
// in a served process nothing changes. Both halves, because the seam is global state.

import { afterEach, describe, expect, test } from 'bun:test';
import { responsiveImage } from './images';
import { type HeadTag, type OpenGraph, renderMeta } from './meta';
import { type StaticImageRequest, setStaticExport } from './static-export';

afterEach(() => setStaticExport(undefined));

const asked: StaticImageRequest[] = [];
const install = (): void => {
  asked.length = 0;
  setStaticExport({
    imageUrl: (request) => {
      asked.push(request);
      return `/_img/h-${String(request.width)}.${request.format ?? 'png'}`;
    },
    cardImage: (path) => ({ url: `/_og${path}.png`, width: 1200, height: 630 }),
  });
};

const HERO = { src: '/assets/hero.1a2b3c4d.png', width: 640, height: 360, alt: 'hero' };
const property = (tags: readonly HeadTag[], name: string): string | undefined =>
  tags.find((tag) => tag.attrs['property'] === name || tag.attrs['name'] === name)?.attrs[
    'content'
  ];

describe('unit · responsiveImage under a static export', () => {
  test('every candidate is the file the export names, and each one is recorded', () => {
    install();
    const image = responsiveImage(HERO, { widths: [320, 640] });
    expect(image.sources[0]?.srcset).toBe('/_img/h-320.webp 320w, /_img/h-640.webp 640w');
    expect(image.img.src).toBe('/_img/h-640.png');
    expect(asked).toContainEqual({ src: HERO.src, width: 320, format: 'webp' });
    expect(asked).toContainEqual({ src: HERO.src, width: 640, format: undefined });
  });

  test('a remote src, a caller urlFor and a served process keep their own URLs', () => {
    install();
    const remote = responsiveImage({ ...HERO, src: 'https://cdn.test/a.png' }, { widths: [320] });
    expect(remote.img.src).toBe('https://cdn.test/a.png?w=640');
    const own = responsiveImage(HERO, { widths: [320], urlFor: (src, w) => `${src}#${w}` });
    expect(own.img.src).toBe(`${HERO.src}#640`);
    setStaticExport(undefined);
    expect(responsiveImage(HERO, { widths: [320] }).img.src).toBe(`${HERO.src}?w=640`);
  });
});

describe('unit · og.capture', () => {
  const meta = { title: 'Hello', description: 'A post', og: { capture: '/og/post/hello' } };

  test('under the export it is og:image at 1200 x 630 and a large twitter card', () => {
    install();
    const tags = renderMeta(meta, { baseUrl: 'https://site.test' });
    expect(property(tags, 'og:image')).toBe('https://site.test/_og/og/post/hello.png');
    expect(property(tags, 'og:image:width')).toBe('1200');
    expect(property(tags, 'og:image:height')).toBe('630');
    expect(property(tags, 'twitter:card')).toBe('summary_large_image');
  });

  test('served, a capture names no file, so no og:image is emitted', () => {
    const tags = renderMeta(meta, { baseUrl: 'https://site.test' });
    expect(property(tags, 'og:image')).toBeUndefined();
    expect(property(tags, 'twitter:card')).toBe('summary');
  });

  test('image and capture together are a type error', () => {
    // @ts-expect-error — one picture source per card, never two.
    const both: OpenGraph = { image: '/a.png', capture: '/og/a' };
    expect(both.capture).toBe('/og/a');
  });
});
