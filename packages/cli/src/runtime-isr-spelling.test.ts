// One `isr` page, every way a URL can spell it, through the real pipeline. The router matches a
// normalised path (`//blog//abc/`, `/blog/%61bc` and `/blog/abc` are one route with one `slug`),
// and the store key was the request's RAW pathname: each spelling was its own stored page, and one
// the route table could not read back (`/blog//abc`) was stored with no ttl and no tags — a
// withdrawal never reached it. "Routes to the same page" has to mean "is the same entry".

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { invalidateTags, isolateGraph, tag } from '@ultimat3/cache';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { clearRoutes, defineRoute, h, registerRoute, withStatus } from '@ultimat3/render';
import type { IsrController } from '@ultimat3/render/server';
import { isrController } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'isr-spelling-under-test';
const postTag = tag('post');
let published = true;

interface Post {
  readonly slug: string;
  readonly at: string;
}

const textOf = (data: unknown, key: keyof Post): string => {
  if (typeof data !== 'object' || data === null || !(key in data)) return '';
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

function registerArticle(onInvalidate: 'purge' | 'stale'): void {
  registerRoute<Post>({
    file: 'apps/web/site/blog/[slug]/page.tsx',
    // The slug the router decoded, and the pathname `load` was handed: what a page builds its
    // `canonical` from, so the first spelling to arrive must not be the one stored for the rest.
    component: (props) =>
      h('p', {}, `slug=[${textOf(props['data'], 'slug')}] at=[${textOf(props['data'], 'at')}]`),
    config: defineRoute<Post>({
      render: 'isr',
      revalidate: { tags: [postTag], ttl: '10m', onInvalidate, query: [] },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      load: async ({ params, url }) => {
        const post = { slug: params['slug'] ?? '', at: new URL(url).pathname };
        return published ? post : withStatus(404, post);
      },
      meta: () => ({ title: 'Article', description: 'an isr article, spelled many ways' }),
    }),
  });
}

const restoreGraph = isolateGraph();

/** Released after each test, pass or fail: a controller left attached leaks its graph edges. */
const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  clearRoutes();
  resetLocaleConfig();
  published = true;
});

afterAll(() => {
  isrController().attach()();
  restoreGraph();
});

interface Served {
  readonly isr: IsrController;
  readonly get: (path: string) => Promise<Response>;
}

function serving(basePath = '/'): Served {
  const { isr, release } = attachedIsr({ buildId: BUILD_ID });
  releases.push(release);
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, isr }),
    role: 'web',
    config: defineHttpConfig({
      dev: true,
      buildId: BUILD_ID,
      basePath,
      rateLimit: { scope: 'process' },
    }),
  });
  return { isr, get: (path) => server.fetch(new Request(`http://dev.test${path}`)) };
}

const SHARED = 'public, max-age=0, s-maxage=600';

interface Page {
  readonly name: string;
  /** The one store key every spelling below has to land on. */
  readonly key: string;
  readonly slug: string;
  readonly pathname: string;
  readonly locales?: boolean;
  readonly basePath?: string;
  readonly spellings: string[];
}

const PAGES: Page[] = [
  {
    name: 'an ASCII slug',
    key: '/blog/abc?__x_locale=en',
    slug: 'abc',
    pathname: '/blog/abc',
    spellings: [
      '/blog/abc',
      '/blog/%61bc',
      '/blog/%61%62%63',
      '/blog/abc/',
      '/blog//abc',
      '//blog/abc',
      '//blog//abc//',
      '/blog/./abc',
      '/blog/x/../abc',
      '/blog/%2e/abc',
      '/blog/x/%2E%2e/abc',
      '/%62log/abc',
    ],
  },
  {
    name: 'a non-ASCII slug',
    key: '/blog/caf%C3%A9?__x_locale=en',
    slug: 'café',
    pathname: '/blog/caf%C3%A9',
    spellings: ['/blog/caf%C3%A9', '/blog/caf%c3%a9', '/blog/café', '/blog//c%61f%C3%a9/'],
  },
  {
    name: 'a slug holding an encoded slash, which is never a separator',
    key: '/blog/a%2Fb?__x_locale=en',
    slug: 'a/b',
    pathname: '/blog/a%2Fb',
    spellings: ['/blog/a%2Fb', '/blog/a%2fb', '/blog//%61%2fb/'],
  },
  {
    name: 'a slug holding an encoded percent sign',
    key: '/blog/a%252Fb?__x_locale=en',
    slug: 'a%2Fb',
    pathname: '/blog/a%252Fb',
    spellings: ['/blog/a%252Fb', '/blog/%61%252Fb'],
  },
  {
    name: 'a slug of characters a pathname leaves as written',
    key: '/blog/@a:b+c,d;e=f?__x_locale=en',
    slug: '@a:b+c,d;e=f',
    pathname: '/blog/@a:b+c,d;e=f',
    spellings: ['/blog/@a:b+c,d;e=f', '/blog/%40a%3Ab%2Bc%2Cd%3be%3Df'],
  },
  {
    name: 'the locale-prefixed page',
    key: '/en/blog/abc?__x_locale=en',
    slug: 'abc',
    pathname: '/en/blog/abc',
    locales: true,
    spellings: [
      '/en/blog/abc',
      '/en/blog/%61bc',
      '/en//blog/abc',
      '/en/blog/abc/',
      '/en/blog/./abc',
    ],
  },
  {
    name: 'the page under a base path',
    key: '/blog/abc?__x_locale=en',
    slug: 'abc',
    pathname: '/shop/blog/abc',
    basePath: '/shop',
    spellings: ['/shop/blog/abc', '/shop/blog/%61bc', '/shop//blog/abc/'],
  },
];

function started(page: Page, onInvalidate: 'purge' | 'stale'): Served {
  if (page.locales === true) configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
  registerArticle(onInvalidate);
  return serving(page.basePath);
}

describe.each(PAGES)('unit · $name, in every spelling the router accepts', (page) => {
  test('is ONE stored page, with its route’s ttl and purge keys, rendered at the canonical URL', async () => {
    const app = started(page, 'purge');
    for (const spelling of page.spellings) {
      const response = await app.get(spelling);
      expect([spelling, response.status]).toEqual([spelling, 200]);
      expect([spelling, response.headers.get('cache-control')]).toEqual([spelling, SHARED]);
      expect([spelling, response.headers.get('surrogate-key')]).toEqual([spelling, 'post e:post']);
      expect([spelling, await response.text()]).toEqual([
        spelling,
        expect.stringContaining(`slug=[${page.slug}] at=[${page.pathname}]`),
      ]);
      expect([spelling, app.isr.store().paths()]).toEqual([spelling, [page.key]]);
    }
    expect(app.isr.store().get(page.key)).toMatchObject({ ttlMs: 600_000, stale: false });
  });

  test.each(page.spellings)('a purge takes it down for a request spelled %s', async (spelling) => {
    const app = started(page, 'purge');
    expect((await app.get(spelling)).status).toBe(200);
    published = false;
    expect((await invalidateTags([postTag])).isr).toEqual([page.key]);
    expect(app.isr.store().paths()).toEqual([]);
    for (const asked of [spelling, ...page.spellings]) {
      expect([asked, (await app.get(asked)).status]).toEqual([asked, 404]);
    }
  });

  test.each(page.spellings)('a stale bust reaches a request spelled %s', async (spelling) => {
    const app = started(page, 'stale');
    expect((await app.get(spelling)).status).toBe(200);
    published = false;
    expect((await invalidateTags([postTag])).isr).toEqual([page.key]);
    expect(app.isr.store().get(page.key)?.stale).toBe(true);
    // Stale-while-revalidate: the copy once more, MARKED, and the 404 renders behind it.
    const stale = await app.get(spelling);
    expect(stale.headers.get('x-ultimate-isr')).toBe('stale');
    let next = await app.get(spelling);
    for (const from = Date.now(); next.status !== 404 && Date.now() - from < 10_000; ) {
      await Bun.sleep(5);
      next = await app.get(spelling);
    }
    expect(next.status).toBe(404);
    expect(app.isr.store().paths()).toEqual([page.key]);
  });
});

describe('unit · an address the router does not match stores nothing', () => {
  test.each(['/blog/a/b', '/blog', '/blog/%ZZ', '/blog/%E0%A4%A'])(
    '%s is refused by the router and leaves the store empty',
    async (path) => {
      registerArticle('purge');
      const app = serving();
      expect((await app.get(path)).status).toBeGreaterThanOrEqual(400);
      expect(app.isr.store().paths()).toEqual([]);
    },
  );

  test.each(['//en/blog/abc', '/%65n/blog/abc', '/EN/blog/abc'])(
    '%s is not a spelling of the English page: no page, no entry',
    async (path) => {
      configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
      registerArticle('purge');
      const app = serving();
      expect((await app.get(path)).status).toBe(404);
      expect(app.isr.store().paths()).toEqual([]);
    },
  );

  test('many spellings of many slugs cannot outnumber the pages they name', async () => {
    registerArticle('purge');
    const app = serving();
    const hex = (char: string): string => `%${char.charCodeAt(0).toString(16)}`;
    for (const slug of ['alpha', 'bravo', 'charlie']) {
      for (let mask = 0; mask < 2 ** slug.length; mask += 1) {
        const spelled = [...slug].map((char, at) => ((mask >> at) & 1 ? hex(char) : char));
        await app.get(`/blog/${spelled.join('')}`);
      }
    }
    expect(app.isr.store().paths()).toEqual([
      '/blog/alpha?__x_locale=en',
      '/blog/bravo?__x_locale=en',
      '/blog/charlie?__x_locale=en',
    ]);
  });
});

/** A second `isr` route, so one address can be read as two routes. */
function registerNews(file: string, body: string): void {
  registerRoute({
    file,
    component: () => h('p', {}, body),
    config: defineRoute({
      render: 'isr',
      revalidate: { tags: [postTag], ttl: '10m', onInvalidate: 'purge', query: [] },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: 'News', description: 'an isr page two routes could claim' }),
    }),
  });
}

describe('unit · a key that reads back as another route is not stored', () => {
  test('`//en/news` is the `/:lang/news` route; its key is the English `/news` page’s, so it is answered uncached', async () => {
    configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
    registerNews('apps/web/site/news/page.tsx', 'THE NEWS');
    registerNews('apps/web/site/[lang]/news/page.tsx', 'BY SECTION');
    const app = serving();

    // The router does not split a locale off `//en/…`, so this is the param route, lang = `en`.
    const sectioned = await app.get('//en/news');
    expect(sectioned.status).toBe(200);
    expect(await sectioned.text()).toContain('BY SECTION');
    expect(sectioned.headers.get('cache-control')).toBe('private, no-store');
    expect(sectioned.headers.get('surrogate-key')).toBeNull();
    expect(app.isr.store().paths()).toEqual([]);

    // The English `/news` page owns that key, and is never answered the other route's document.
    const english = await app.get('/en/news');
    expect(await english.text()).toContain('THE NEWS');
    expect(english.headers.get('cache-control')).toBe(SHARED);
    expect(app.isr.store().paths()).toEqual(['/en/news?__x_locale=en']);
    expect(await (await app.get('//en/news')).text()).toContain('BY SECTION');
    expect(await (await app.get('/en/news')).text()).toContain('THE NEWS');
  });

  test('a locale’s home is one entry, rendered at `/en/` however the slash was written', async () => {
    configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
    registerRoute<Post>({
      file: 'apps/web/site/page.tsx',
      component: (props) => h('p', {}, `at=[${textOf(props['data'], 'at')}]`),
      config: defineRoute<Post>({
        render: 'isr',
        revalidate: { tags: [postTag], ttl: '10m', query: [] },
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        load: async ({ url }) => ({ slug: '', at: new URL(url).pathname }),
        meta: () => ({ title: 'Home', description: 'an isr home page in two locales' }),
      }),
    });
    const app = serving();
    for (const spelling of ['/en', '/en/', '/en//']) {
      expect(await (await app.get(spelling)).text()).toContain('at=[/en/]');
    }
    for (const spelling of ['/', '//']) {
      expect(await (await app.get(spelling)).text()).toContain('at=[/]');
    }
    expect(app.isr.store().paths()).toEqual(['/?__x_locale=es-CO', '/en?__x_locale=en']);
  });
});
