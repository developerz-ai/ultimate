// The `site` and `seo` sections: defaults, overlay merge, and the refusals `defineConfig` raises.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

const causeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (!isUltimateError(error)) return expect.unreachable('defineConfig threw its own error');
    return error.cause;
  }
  return expect.unreachable('expected X_CONFIG_INVALID, nothing was thrown');
};

describe('site and seo — refusals', () => {
  test('an origin with a path, a non-http scheme or no scheme is refused', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', site: { origin: 'https://x.co/app' } })),
    ).toContain('origin only');
    expect(causeOf(() => defineConfig({ name: 'app', site: { origin: 'ftp://x.co' } }))).toContain(
      'http:// or https://',
    );
    expect(causeOf(() => defineConfig({ name: 'app', site: { origin: 'x.co' } }))).toContain(
      'not an absolute URL',
    );
  });

  test('a disallow path that does not start with / is refused', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', seo: { robots: { disallow: ['panel'] } } })),
    ).toContain('must start with /');
  });
});

describe('seo.sitemap — refusals', () => {
  test('an extra that is not a bare path is refused', () => {
    for (const bad of ['verificar', 'https://x.co/verificar', '//x.co/a', '/a?b=1', '/a#top']) {
      expect(
        causeOf(() => defineConfig({ name: 'app', seo: { sitemap: { extra: [bad] } } })),
      ).toContain('seo.sitemap.extra');
    }
  });

  test('an unknown lastmod source is refused', () => {
    expect(
      causeOf(() =>
        defineConfig({ name: 'app', seo: { sitemap: { lastmod: 'weekly' as 'git' } } }),
      ),
    ).toContain('seo.sitemap.lastmod');
  });
});

describe('seo.sitemap.sections and pageSize — refusals', () => {
  const sections = (value: unknown, pageSize?: unknown): string =>
    causeOf(() =>
      defineConfig({
        name: 'app',
        seo: {
          sitemap: {
            sections: value as [],
            ...(pageSize === undefined ? {} : { pageSize: pageSize as number }),
          },
        },
      }),
    );

  test('a name that is not a lower-case slug is refused: it becomes a file name', () => {
    for (const name of ['Blog', 'blog posts', '../x', 'blog_', '-blog', 'a--b', '', 5]) {
      expect(sections([{ name, match: '/blog/**' }])).toContain('lower-case slug');
    }
  });

  test('the default section`s name is reserved, and a name may be declared once', () => {
    expect(sections([{ name: 'pages', match: '/a' }])).toContain('reserved');
    expect(
      sections([
        { name: 'blog', match: '/blog/**' },
        { name: 'blog', match: '/notas/**' },
      ]),
    ).toContain('twice');
  });

  test('a match that is not a path pattern is refused, naming the section', () => {
    for (const match of ['blog/**', '/blog?x=1', '//x.co/a', '/a/**/b', '/blog/p*', [], 7]) {
      expect(sections([{ name: 'blog', match }])).toContain('seo.sitemap.sections "blog" match');
    }
    expect(sections('blog')).toContain('must be a list');
    expect(sections([null])).toContain('must be { name, match }');
  });

  test('pageSize is a whole number within the protocol cap', () => {
    for (const pageSize of [0, -1, 2.5, 50_001, '1000', Number.NaN]) {
      expect(sections([], pageSize)).toContain('seo.sitemap.pageSize');
    }
  });

  test('the refusal is the typed boot error, with a runnable fix', () => {
    let thrown: unknown;
    try {
      defineConfig({ name: 'app', seo: { sitemap: { sections: [{ name: 'B', match: '/b' }] } } });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('X_CONFIG_INVALID');
    expect((thrown as { fix?: string }).fix).toMatch(/x verify/);
  });

  test('sections and pageSize are accepted in every documented form', () => {
    const config = defineConfig({
      name: 'app',
      seo: {
        sitemap: {
          pageSize: 1000,
          sections: [
            { name: 'blog', match: '/blog/**' },
            { name: 'ciudades', match: ['/juzgados/**', '/ciudades/*'] },
          ],
        },
      },
    });
    expect(config.seo.sitemap.pageSize).toBe(1000);
    expect(config.seo.sitemap.sections.map((section) => section.name)).toEqual([
      'blog',
      'ciudades',
    ]);
  });
});

describe('site and seo', () => {
  test('seo.sitemap merges beside robots, key by key', () => {
    const config = defineConfig(
      { name: 'app', seo: { sitemap: { extra: ['/verificar'] } } },
      { seo: { sitemap: { lastmod: 'git' } } },
    );
    expect(config.seo.sitemap).toEqual({
      extra: ['/verificar'],
      lastmod: 'git',
      sections: [],
      pageSize: 50_000,
    });
    expect(config.seo.robots.disallow).toEqual([]);
  });

  test('defaults: no origin, nothing disallowed', () => {
    const config = defineConfig({ name: 'app' });
    expect(config.site).toEqual({ origin: null });
    expect(config.seo).toEqual({
      robots: { disallow: [] },
      sitemap: { extra: [], lastmod: 'none', sections: [], pageSize: 50_000 },
    });
  });

  test('an overlay patches one section without dropping the other', () => {
    const config = defineConfig(
      { name: 'app', site: { origin: 'https://notificado.co' } },
      { seo: { robots: { disallow: ['/panel'] } } },
    );
    expect(config.site.origin).toBe('https://notificado.co');
    expect(config.seo.robots.disallow).toEqual(['/panel']);
  });
});
