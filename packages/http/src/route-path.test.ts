// The one spelling of a pathname, held against the router it is shared with: a spelling the router
// answers with a route and its params has to be answered identically in its canonical form, and
// two spellings the router tells apart must not collapse into one.
import { afterEach, describe, expect, test } from 'bun:test';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { defineHttpConfig } from './config';
import { requestAddress } from './locale-prefix';
import { httpPipeline } from './pipeline';
import { jsonResponse } from './response';
import { canonicalPath, canonicalSegment, normalizePath, pathSegments } from './route-path';
import { httpRouter, matchRoute, type Route } from './router';

/** What a URL's own parser hands the pipeline for a path a client typed. */
const pathnameOf = (typed: string): string => new URL(`http://app.test${typed}`).pathname;

describe('unit · canonicalPath is one spelling per address', () => {
  test.each([
    ['/', '/'],
    ['//', '/'],
    ['/blog/abc', '/blog/abc'],
    ['/blog/abc/', '/blog/abc'],
    ['/blog//abc', '/blog/abc'],
    ['//blog/abc', '/blog/abc'],
    ['///blog///abc///', '/blog/abc'],
    ['/blog/%61bc', '/blog/abc'],
    ['/%62%6c%6F%67/%61%62%63', '/blog/abc'],
    ['/blog/caf%c3%a9', '/blog/caf%C3%A9'],
    ['/blog/caf%C3%A9', '/blog/caf%C3%A9'],
    ['/blog/a%20b', '/blog/a%20b'],
    ['/blog/%7Ea', '/blog/~a'],
    ['/blog/%40a%3Ab%2Bc%2Cd%3Be%3Df%24g%26h', '/blog/@a:b+c,d;e=f$g&h'],
    ['/blog/@a:b+c,d;e=f$g&h', '/blog/@a:b+c,d;e=f$g&h'],
    ['/blog/a%3Fb%23c', '/blog/a%3Fb%23c'],
  ])('%s is %s', (typed, canonical) => {
    expect(canonicalPath(typed)).toBe(canonical);
  });

  test('an encoded slash stays encoded, in one hex case, and is never a separator', () => {
    expect(canonicalPath('/blog/a%2fb')).toBe('/blog/a%2Fb');
    expect(canonicalPath('/blog/a%2Fb')).toBe('/blog/a%2Fb');
    expect(canonicalPath('/blog/a%2Fb')).not.toBe(canonicalPath('/blog/a/b'));
    expect(canonicalPath('/blog/a%5Cb')).toBe('/blog/a%5Cb');
  });

  test('an encoded percent sign is not decoded twice', () => {
    expect(canonicalPath('/blog/a%252Fb')).toBe('/blog/a%252Fb');
    expect(canonicalPath('/blog/%2561')).toBe('/blog/%2561');
    expect(canonicalPath('/blog/%2561')).not.toBe(canonicalPath('/blog/%61'));
  });

  test('a segment that will not decode is kept as written, and never throws', () => {
    for (const bad of ['%ZZ', '%', '%E0%A4%A', 'a%C3', '\uD800']) {
      expect(canonicalSegment(bad)).toBe(bad);
    }
    expect(canonicalPath('/blog//%ZZ/')).toBe('/blog/%ZZ');
  });

  test('dot segments are the URL parser’s, resolved before a pathname exists', () => {
    for (const typed of ['/blog/./abc', '/blog/x/../abc', '/blog/%2e/abc', '/blog/x/%2E%2e/abc']) {
      expect(canonicalPath(pathnameOf(typed))).toBe('/blog/abc');
    }
  });

  test('it is idempotent, and a URL carries it back unchanged', () => {
    for (const typed of ['/blog//%61%2fb/', '/blog/caf%c3%a9', '/a%20b/@c:d', '/blog/a%252Fb']) {
      const once = canonicalPath(pathnameOf(typed));
      expect(canonicalPath(once)).toBe(once);
      expect(pathnameOf(once)).toBe(once);
    }
  });

  test('normalizePath and the router’s segments are the same split', () => {
    expect(pathSegments('//a//b/')).toEqual(['a', 'b']);
    expect(normalizePath('//a//%62/')).toBe('/a/%62');
  });
});

const named = (path: string): Route => ({
  method: 'GET',
  path,
  meta: { name: path, auth: 'public' },
  handler: (_request, ctx) =>
    jsonResponse({ routePath: ctx.routePath, address: requestAddress(ctx), params: ctx.params }),
});

const ROUTES = [
  '/',
  '/blog',
  '/blog/:slug',
  '/docs/*path',
  '/precios-españa',
  '/:lang/news',
  '/news',
].map(named);

describe('unit · the router answers a spelling and its canonical form alike', () => {
  const table = httpRouter(ROUTES);
  const answer = (path: string): unknown => {
    const match = matchRoute(table, 'GET', path);
    return match.ok ? [match.route.path, match.params] : match.reason;
  };

  test.each([
    '/',
    '//',
    '/blog/',
    '//blog',
    '/blog/abc',
    '/blog/%61bc',
    '/blog//abc/',
    '/blog/caf%c3%a9',
    '/blog/a%2fb',
    '/blog/a%252Fb',
    '/blog/a/b',
    '/blog/%ZZ',
    '/docs',
    '/docs/a//b/',
    '/docs/%61/b',
    '/precios-espa%C3%B1a',
    '/precios-espa%c3%b1a/',
    '/%65n/news',
    '/nothing/here',
  ])('%s', (typed) => {
    const pathname = pathnameOf(typed);
    expect(answer(canonicalPath(pathname))).toEqual(answer(pathname));
  });

  test('spellings of one page share a canonical path; different pages never do', () => {
    const same = ['/blog/abc', '/blog/%61bc', '//blog//abc/', '/%62log/abc'].map(pathnameOf);
    expect(new Set(same.map(canonicalPath)).size).toBe(1);
    expect(new Set(same.map((path) => JSON.stringify(answer(path)))).size).toBe(1);
    const apart = ['/blog/a%2Fb', '/blog/a/b', '/blog/a%252Fb', '/blog/ab'].map(pathnameOf);
    expect(new Set(apart.map(canonicalPath)).size).toBe(apart.length);
  });
});

describe('unit · the context stage records where a request was matched', () => {
  afterEach(() => resetLocaleConfig());

  const asked = async (typed: string, basePath = '/'): Promise<Record<string, unknown>> => {
    const config = defineHttpConfig({
      rateLimit: { enabled: false, scope: 'process' },
      dev: false,
      buildId: null,
      basePath,
    });
    const pipeline = httpPipeline({ table: httpRouter(ROUTES), config, hooks: {} });
    const response = await pipeline.handle(new Request(`http://app.test${typed}`), { role: 'web' });
    return { status: response.status, ...((await response.json()) as Record<string, unknown>) };
  };

  test.each(['/blog/abc', '/blog/%61bc', '/blog//abc/', '//blog/abc', '/blog/./abc'])(
    '%s was matched at /blog/abc',
    async (typed) => {
      expect(await asked(typed)).toMatchObject({
        status: 200,
        routePath: '/blog/abc',
        address: { path: '/blog/abc', pathname: '/blog/abc' },
        params: { slug: 'abc' },
      });
    },
  );

  test('a routed locale prefix is kept in the address and left out of the route path', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    for (const typed of ['/en/blog/abc', '/en//blog/%61bc/']) {
      expect(await asked(typed)).toMatchObject({
        routePath: '/blog/abc',
        address: { path: '/en/blog/abc', pathname: '/en/blog/abc' },
      });
    }
    // The locale's root is spelled as `localizedPath` spells it — the directory, `/en/`.
    for (const typed of ['/en', '/en/', '/en//']) {
      expect(await asked(typed)).toMatchObject({
        routePath: '/',
        address: { path: '/en/', pathname: '/en/' },
      });
    }
  });

  test('a prefix the router did not split is not one: `//en/news` is the `/:lang/news` route', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    expect(await asked('//en/news')).toMatchObject({
      routePath: '/en/news',
      params: { lang: 'en' },
      address: { path: '/en/news' },
    });
    expect(await asked('/en/news')).toMatchObject({
      routePath: '/news',
      params: {},
      address: { path: '/en/news' },
    });
  });

  test('a locale segment AFTER the prefix is the route’s own, and is not folded into it', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    expect(await asked('/en/en/news')).toMatchObject({
      routePath: '/en/news',
      params: { lang: 'en' },
      address: { path: '/en/en/news', pathname: '/en/en/news' },
    });
  });

  test('a base path is in the pathname and never in the path a store keys on', async () => {
    for (const typed of ['/shop/blog/abc', '/shop//blog/%61bc/']) {
      expect(await asked(typed, '/shop')).toMatchObject({
        routePath: '/blog/abc',
        address: { path: '/blog/abc', pathname: '/shop/blog/abc' },
      });
    }
    expect(await asked('/shop', '/shop')).toMatchObject({
      routePath: '/',
      address: { path: '/', pathname: '/shop' },
    });
  });
});
