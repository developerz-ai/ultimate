// Named, paginated sitemap sections: `/sitemap.xml` as an index by CONFIGURATION, each child a
// valid urlset, the caps still splitting a section — and, with no section declared, the bytes
// every release before this one wrote.

import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';
import type { RouteRecord } from './routes';
import { buildSitemap, SITEMAP_MAX_BYTES } from './sitemap';
import { sectionOf } from './sitemap-sections';

const ORIGIN = 'https://notificado.co';
const BASE = { baseUrl: ORIGIN } as const;

function route(partial: Partial<RouteRecord> & Pick<RouteRecord, 'path' | 'file'>): RouteRecord {
  return { surface: 'site', render: 'static', ...partial };
}

const locs = (xml: string | undefined) =>
  [...(xml ?? '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');
const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

const SECTIONS = [
  { name: 'blog', match: '/blog/**' },
  { name: 'ciudades', match: ['/juzgados/**', '/ciudades/*'] },
] as const;

const site = (): RouteRecord[] => [
  route({ path: '/', file: 'site/page.tsx', lastmod: '2026-10-01T00:00:00.000Z' }),
  route({ path: '/precios', file: 'site/precios/page.tsx', changefreq: 'weekly', priority: 0.8 }),
  route({
    path: '/blog/:slug',
    file: 'site/blog/[slug]/page.tsx',
    render: 'isr',
    prerender: () => ['/blog/b', '/blog/a?x=1&y=2'],
  }),
];

describe('no sections configured', () => {
  // Captured from the release before sections existed (27.8.1), over this exact fixture.
  test('the single urlset is byte-identical to what it always was', async () => {
    const result = await buildSitemap(site(), {
      ...BASE,
      locales: ['es-co', 'en'],
      defaultLocale: 'es-co',
    });
    expect(result.index).toBeUndefined();
    expect(result.files.map((file) => file.path)).toEqual(['/sitemap.xml']);
    expect(result.files[0]?.xml.length).toBe(3047);
    expect(sha(result.files[0]?.xml ?? '')).toBe(
      'e17df8fe22fec2d3f10140132f883e707bfbcc934f55f98f455188e745b36c7e',
    );
  });

  test('a split past the cap is byte-identical too: /sitemaps/<n>.xml, an index with no lastmod', async () => {
    const result = await buildSitemap(site(), { ...BASE, maxUrls: 3 });
    const all = [result.index, ...result.files].map((file) => `${file?.path}\n${file?.xml}`);
    expect(sha(all.join('\n'))).toBe(
      'de7c14d80e71b8b804596b91a108ad0dc3ea7cd4d5bf2d8f4eb2fc406a25a457',
    );
  });

  test('an empty `sections` is no sections', async () => {
    const result = await buildSitemap(site(), { ...BASE, sections: [] });
    expect(result.index).toBeUndefined();
    expect(result.files.map((file) => file.path)).toEqual(['/sitemap.xml']);
  });
});

describe('sections', () => {
  test('/sitemap.xml is an index of named, numbered children; unmatched pages go to `pages`', async () => {
    const result = await buildSitemap(
      [
        ...site(),
        route({
          path: '/juzgados/:ciudad',
          file: 'site/juzgados/[ciudad]/page.tsx',
          prerender: () => ['/juzgados/medellin', '/juzgados/bogota'],
        }),
      ],
      { ...BASE, sections: SECTIONS },
    );
    expect(result.index?.path).toBe('/sitemap.xml');
    expect(result.index?.xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        '  <sitemap>\n' +
        `    <loc>${ORIGIN}/sitemaps/pages-1.xml</loc>\n` +
        '    <lastmod>2026-10-01T00:00:00.000Z</lastmod>\n' +
        '  </sitemap>\n' +
        '  <sitemap>\n' +
        `    <loc>${ORIGIN}/sitemaps/blog-1.xml</loc>\n` +
        '  </sitemap>\n' +
        '  <sitemap>\n' +
        `    <loc>${ORIGIN}/sitemaps/ciudades-1.xml</loc>\n` +
        '  </sitemap>\n' +
        '</sitemapindex>\n',
    );
    expect(result.files.map((file) => file.path)).toEqual([
      '/sitemaps/pages-1.xml',
      '/sitemaps/blog-1.xml',
      '/sitemaps/ciudades-1.xml',
    ]);
    expect(result.urlCount).toBe(6);
    for (const file of result.files) {
      expect(file.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset ')).toBe(true);
      expect(file.xml.endsWith('</urlset>\n')).toBe(true);
    }
    expect(locs(result.files[0]?.xml)).toEqual([ORIGIN, `${ORIGIN}/precios`]);
    // Sorted by path inside a section, whatever order `prerender()` answered in.
    expect(locs(result.files[1]?.xml)).toEqual([
      `${ORIGIN}/blog/a?x=1&amp;y=2`,
      `${ORIGIN}/blog/b`,
    ]);
    expect(locs(result.files[2]?.xml)).toEqual([
      `${ORIGIN}/juzgados/bogota`,
      `${ORIGIN}/juzgados/medellin`,
    ]);
  });

  test('pageSize paginates each section on its own', async () => {
    const posts = Array.from({ length: 5 }, (_unused, index) => `/blog/p${index}`);
    const result = await buildSitemap(
      [
        route({ path: '/', file: 'site/page.tsx' }),
        route({ path: '/blog/:slug', file: 'site/blog/[slug]/page.tsx', prerender: () => posts }),
      ],
      { ...BASE, sections: SECTIONS, maxUrls: 2 },
    );
    expect(result.files.map((file) => [file.path, file.urlCount])).toEqual([
      ['/sitemaps/pages-1.xml', 1],
      ['/sitemaps/blog-1.xml', 2],
      ['/sitemaps/blog-2.xml', 2],
      ['/sitemaps/blog-3.xml', 1],
    ]);
    expect(locs(result.index?.xml)).toEqual(result.files.map((file) => `${ORIGIN}${file.path}`));
  });

  test('a section that would be empty is omitted, the default one included', async () => {
    const result = await buildSitemap(
      [
        route({
          path: '/blog/:slug',
          file: 'site/blog/[slug]/page.tsx',
          prerender: () => ['/blog/a'],
        }),
      ],
      { ...BASE, sections: SECTIONS },
    );
    expect(result.files.map((file) => file.path)).toEqual(['/sitemaps/blog-1.xml']);
    expect(locs(result.index?.xml)).toEqual([`${ORIGIN}/sitemaps/blog-1.xml`]);
  });

  test('a site with no URL at all is the empty urlset, never an index of nothing', async () => {
    const result = await buildSitemap([], { ...BASE, sections: SECTIONS });
    expect(result.index).toBeUndefined();
    expect(result.files.map((file) => file.path)).toEqual(['/sitemap.xml']);
    expect(result.files[0]?.xml).toContain('<urlset');
  });

  test('the same pages in another order produce the same bytes', async () => {
    const build = (slugs: readonly string[]) =>
      buildSitemap(
        [
          route({ path: '/blog/:slug', file: 'site/blog/[slug]/page.tsx', prerender: () => slugs }),
          route({ path: '/precios', file: 'site/precios/page.tsx' }),
          route({ path: '/', file: 'site/page.tsx' }),
        ],
        {
          ...BASE,
          sections: SECTIONS,
          maxUrls: 2,
          locales: ['es-co', 'en'],
          defaultLocale: 'es-co',
        },
      );
    const first = await build(['/blog/c', '/blog/a', '/blog/b']);
    const second = await build(['/blog/b', '/blog/c', '/blog/a']);
    expect(second.files).toEqual(first.files);
    expect(second.index).toEqual(first.index);
  });

  test('a page and its locale copies file together, each carrying the whole hreflang cluster', async () => {
    const result = await buildSitemap(
      [
        route({ path: '/', file: 'site/page.tsx' }),
        route({
          path: '/blog/:slug',
          file: 'site/blog/[slug]/page.tsx',
          prerender: () => ['/blog/a'],
        }),
      ],
      { ...BASE, sections: SECTIONS, locales: ['es-co', 'en'], defaultLocale: 'es-co' },
    );
    const blog = result.files.find((file) => file.path === '/sitemaps/blog-1.xml')?.xml ?? '';
    expect(locs(blog)).toEqual([`${ORIGIN}/blog/a`, `${ORIGIN}/en/blog/a`]);
    expect(blog).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    for (const tag of [
      `hreflang="es-CO" href="${ORIGIN}/blog/a"`,
      `hreflang="en" href="${ORIGIN}/en/blog/a"`,
      `hreflang="x-default" href="${ORIGIN}/blog/a"`,
    ]) {
      expect(blog.split(tag).length - 1).toBe(2);
    }
  });

  test('the index lastmod of a child is the newest lastmod inside it', async () => {
    const result = await buildSitemap(
      [
        route({
          path: '/blog/:slug',
          file: 'site/blog/[slug]/page.tsx',
          prerender: () => [
            { path: '/blog/a', lastmod: '2026-09-01T10:00:00Z' },
            { path: '/blog/b', lastmod: '2026-10-05T08:30:00-05:00' },
            { path: '/blog/c' },
          ],
        }),
      ],
      { ...BASE, sections: SECTIONS, now: new Date('2026-10-11T00:00:00Z') },
    );
    expect(result.index?.xml).toContain('<lastmod>2026-10-05T13:30:00.000Z</lastmod>');
    expect(result.index?.xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  test('an invalid section is refused before any file is built', async () => {
    for (const sections of [
      [{ name: 'Blog', match: '/blog/**' }],
      [{ name: 'pages', match: '/a' }],
      [{ name: 'blog', match: 'blog' }],
    ]) {
      let code: unknown;
      try {
        await buildSitemap(site(), { ...BASE, sections });
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      expect(code).toBe('X_INVARIANT');
    }
  });

  test('more children than an index can hold is refused', async () => {
    const posts = Array.from({ length: 50_001 }, (_unused, index) => `/blog/${index}`);
    let code: unknown;
    try {
      await buildSitemap(
        [route({ path: '/blog/:slug', file: 'site/blog/[slug]/page.tsx', prerender: () => posts })],
        { ...BASE, sections: SECTIONS, maxUrls: 1 },
      );
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe(SEO_ERROR_CODES.sitemapTooLarge);
  });
});

describe('the byte cap', () => {
  test('is the protocol`s 50 MB, uncompressed', () => {
    expect(SITEMAP_MAX_BYTES).toBe(52_428_800);
  });

  test('a section over the byte cap splits further, each file under it', async () => {
    const posts = Array.from({ length: 40 }, (_unused, index) => `/blog/post-${index}`);
    const maxBytes = 1200;
    const result = await buildSitemap(
      [route({ path: '/blog/:slug', file: 'site/blog/[slug]/page.tsx', prerender: () => posts })],
      { ...BASE, sections: SECTIONS, maxBytes },
    );
    expect(result.files.length).toBeGreaterThan(1);
    expect(result.urlCount).toBe(40);
    for (const file of result.files) {
      expect(new TextEncoder().encode(file.xml).length).toBeLessThanOrEqual(maxBytes);
    }
    expect(result.files.map((file) => file.path)).toEqual(
      result.files.map((_file, index) => `/sitemaps/blog-${index + 1}.xml`),
    );
  });

  test('without sections the byte cap splits the one urlset the same way', async () => {
    const posts = Array.from({ length: 40 }, (_unused, index) => `/blog/post-${index}`);
    const result = await buildSitemap(
      [route({ path: '/blog/:slug', file: 'site/blog/[slug]/page.tsx', prerender: () => posts })],
      { ...BASE, maxBytes: 1200 },
    );
    expect(result.index?.path).toBe('/sitemap.xml');
    expect(result.files[0]?.path).toBe('/sitemaps/1.xml');
    for (const file of result.files) {
      expect(new TextEncoder().encode(file.xml).length).toBeLessThanOrEqual(1200);
    }
  });
});

describe('sectionOf', () => {
  test('exact, one-segment and subtree patterns; the first section that matches wins', () => {
    const sections = [
      { name: 'guias', match: '/blog/guias/**' },
      { name: 'blog', match: ['/blog/**'] },
      { name: 'ciudades', match: '/ciudades/*' },
      { name: 'precios', match: '/precios' },
    ];
    expect(sectionOf('/blog', sections)).toBe('blog');
    expect(sectionOf('/blog/a', sections)).toBe('blog');
    expect(sectionOf('/blog/a/b', sections)).toBe('blog');
    expect(sectionOf('/blog/guias/x', sections)).toBe('guias');
    expect(sectionOf('/blogs', sections)).toBe('pages');
    expect(sectionOf('/ciudades/cali', sections)).toBe('ciudades');
    expect(sectionOf('/ciudades', sections)).toBe('pages');
    expect(sectionOf('/ciudades/cali/juzgados', sections)).toBe('pages');
    expect(sectionOf('/precios', sections)).toBe('precios');
    expect(sectionOf('/precios/', sections)).toBe('precios');
    expect(sectionOf('/precios?plan=a', sections)).toBe('precios');
    expect(sectionOf('/', sections)).toBe('pages');
  });
});
