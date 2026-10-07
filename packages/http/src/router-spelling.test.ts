// The router against the paths a page is actually written at and requested by: a catch-all with an
// empty rest is the bare prefix `@ultimat3/render`'s static build writes (`/docs`), and a literal
// segment outside ASCII arrives percent-encoded, because `URL.pathname` encodes it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { textResponse } from './response';
import { httpRouter, type MatchResult, matchRoute, type Route } from './router';
import { httpServer } from './server';

const route = (method: Route['method'], path: string, name = path): Route => ({
  method,
  path,
  handler: (request) => textResponse(`${name} ${JSON.stringify(request.params)}`),
  meta: { name, auth: 'public' },
});

const nameOf = (result: MatchResult): string =>
  result.ok ? result.route.meta.name : `${result.reason}`;
const paramsOf = (result: MatchResult): unknown => (result.ok ? result.params : undefined);

describe('a catch-all with an empty rest', () => {
  const table = httpRouter([route('GET', '/docs/*path', 'docs')]);

  test('matches the bare prefix, with the empty path the static build fills it with', () => {
    for (const path of ['/docs', '/docs/']) {
      const result = matchRoute(table, 'GET', path);
      expect([nameOf(result), paramsOf(result)]).toEqual(['docs', { path: '' }]);
    }
    expect(paramsOf(matchRoute(table, 'GET', '/docs/a/b'))).toEqual({ path: 'a/b' });
  });

  test('is still bounded by its prefix', () => {
    for (const path of ['/doc', '/docsx', '/']) {
      expect(nameOf(matchRoute(table, 'GET', path))).toBe('not-found');
    }
  });

  test('a static route at the prefix wins it; a param beside it keeps its one segment', () => {
    const both = httpRouter([
      route('GET', '/docs/*path', 'docs'),
      route('GET', '/docs', 'docs.index'),
      route('GET', '/docs/:slug', 'docs.page'),
    ]);
    expect(nameOf(matchRoute(both, 'GET', '/docs'))).toBe('docs.index');
    expect(nameOf(matchRoute(both, 'GET', '/docs/intro'))).toBe('docs.page');
    expect(nameOf(matchRoute(both, 'GET', '/docs/a/b'))).toBe('docs');
  });

  test('a static route for another method still lets the catch-all answer GET', () => {
    const split = httpRouter([
      route('GET', '/docs/*path', 'docs'),
      route('POST', '/docs', 'docs.create'),
    ]);
    expect(nameOf(matchRoute(split, 'GET', '/docs'))).toBe('docs');
    expect(nameOf(matchRoute(split, 'POST', '/docs'))).toBe('docs.create');
  });

  test('at the root, it answers the root', () => {
    const root = httpRouter([route('GET', '/*path', 'all')]);
    expect(paramsOf(matchRoute(root, 'GET', '/'))).toEqual({ path: '' });
  });
});

describe('a literal segment outside ASCII', () => {
  const table = httpRouter([
    route('GET', '/precios-españa', 'precios'),
    route('GET', '/precios-españa/:plan', 'plan'),
  ]);

  test('matches its percent-encoded request spelling, in either hex case, and its raw one', () => {
    for (const path of ['/precios-espa%C3%B1a', '/precios-espa%c3%b1a', '/precios-españa']) {
      expect(nameOf(matchRoute(table, 'GET', path))).toBe('precios');
    }
    expect(paramsOf(matchRoute(table, 'GET', '/precios-espa%C3%B1a/pro'))).toEqual({
      plan: 'pro',
    });
  });

  test('a malformed escape is a 404 or path-invalid, never a thrown URIError', () => {
    expect(nameOf(matchRoute(table, 'GET', '/precios-espa%C3'))).toBe('not-found');
    expect(nameOf(matchRoute(table, 'GET', '/precios-espa%C3%B1a/%ZZ'))).toBe('path-invalid');
  });
});

describe('the live server', () => {
  beforeEach(resetLifecycle);
  afterEach(resetLifecycle);

  test('answers the bare catch-all prefix and the encoded literal over a real socket', async () => {
    const handle = httpServer({
      routes: [route('GET', '/docs/*path', 'docs'), route('GET', '/precios-españa', 'precios')],
      role: 'web',
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        port: 0,
        hostname: '127.0.0.1',
        dev: false,
      }),
    }).start();
    try {
      const docs = await fetch(`${handle.url()}/docs`);
      expect([docs.status, await docs.text()]).toEqual([200, 'docs {"path":""}']);
      const precios = await fetch(`${handle.url()}/precios-españa`);
      expect([precios.status, await precios.text()]).toEqual([200, 'precios {}']);
    } finally {
      await handle.stop();
    }
  });
});
