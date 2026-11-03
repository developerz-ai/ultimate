// The key of a shared document moves once, in one major: it carries the query the route declared
// and nothing else, and, where no origin is declared, the origin the document's absolute URLs name.
// Both are about who chooses what is stored: the route, never the visitor.

import { describe, expect, test } from 'bun:test';
import {
  ISR_ORIGIN_PARAM,
  isrKey,
  isrRequestUrl,
  routePathOf,
  undeclaredQuery,
} from './render-isr-key';
import { defineRoute } from './route';

const at = (path: string, origin = 'https://app.test'): URL => new URL(`${origin}${path}`);
const keyOf = (path: string, query: readonly string[] | null, locale = 'en'): string =>
  isrKey(isrRequestUrl(at(path), query), locale);

describe('unit · what an isr route with no revalidate.query keys on', () => {
  test('none of its query: any query string is one key', () => {
    expect(keyOf('/blog?x=1', null)).toBe(keyOf('/blog?x=2', null));
    expect(keyOf('/blog?utm_source=mail&fbclid=abc', null)).toBe(keyOf('/blog', null));
  });

  test('the URL load is handed is the same narrowing, so nothing outside the key reaches it', () => {
    expect(isrRequestUrl(at('/blog?x=1#top'), null).href).toBe('https://app.test/blog');
  });

  test('a declared parameter still splits, and only it', () => {
    expect(keyOf('/blog?x=1', ['x'])).not.toBe(keyOf('/blog?x=2', ['x']));
    expect(keyOf('/blog?x=1&y=1', ['x'])).toBe(keyOf('/blog?x=1&y=2', ['x']));
  });

  test('the locale still splits', () => {
    expect(keyOf('/blog', null, 'es')).not.toBe(keyOf('/blog', null, 'en'));
  });

  test('undeclaredQuery still names what the narrowing dropped', () => {
    expect(undeclaredQuery(at('/blog?x=1&y=2'), null)).toEqual(['x', 'y']);
  });
});

describe('unit · the origin a key carries when the app declares none', () => {
  const keyAt = (origin: string): string => isrKey(at('/blog', origin), 'en', origin);

  test('two origins are two keys; omitted, the key names none', () => {
    expect(keyAt('https://a.test')).toBe('/blog?__x_locale=en&__x_origin=https%3A%2F%2Fa.test');
    expect(keyAt('https://a.test')).not.toBe(keyAt('https://b.test'));
    expect(isrKey(at('/blog'), 'en')).toBe('/blog?__x_locale=en');
  });

  test('a parameter and not a prefix: the route table still reads the key back', () => {
    expect(routePathOf(keyAt('https://a.test'))).toBe('/blog');
  });

  test('a declared parameter sits beside it, sorted', () => {
    const narrowed = isrRequestUrl(at('/blog?page=2&x=1'), ['page']);
    expect(isrKey(narrowed, 'en', 'https://a.test')).toBe(
      '/blog?__x_locale=en&__x_origin=https%3A%2F%2Fa.test&page=2',
    );
  });

  test('the request cannot choose it', () => {
    const named = `/blog?${ISR_ORIGIN_PARAM}=https%3A%2F%2Fevil.test`;
    // Narrowed away first, and refused by name for a caller who keyed an unnarrowed URL.
    expect(keyOf(named, null)).toBe(keyOf('/blog', null));
    expect(isrKey(at(named), 'en')).toBe('/blog?__x_locale=en');
    expect(isrKey(at(named), 'en', 'https://a.test')).toBe(keyAt('https://a.test'));
  });

  test('a route cannot declare it', () => {
    expect(() =>
      defineRoute({
        render: 'isr',
        revalidate: { ttl: '5m', query: [ISR_ORIGIN_PARAM] },
        offline: 'network-only',
        hydrate: 'never',
        meta: () => ({ title: 't', description: 'd' }),
      }),
    ).toThrow(expect.objectContaining({ code: 'X_ROUTE_MODE_INVALID' }));
  });
});
