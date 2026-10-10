// The query an `isr` page is keyed on is the ROUTE's to declare. The key used to carry whatever
// the visitor sent, so `/blog?x=1`, `/blog?x=2`, … were each a miss, a render and a stored entry:
// a cost-amplification vector for any `isr` route, and `utm_*` split one page into many entries.

import { describe, expect, test } from 'bun:test';
import { isrKey, isrRequestUrl, undeclaredQuery } from './render-isr-key';

const at = (path: string): URL => new URL(`https://app.test${path}`);
const keyOf = (path: string, query: readonly string[] | null): string =>
  isrKey(isrRequestUrl(at(path), query), 'en');

describe('unit · the keyed query of an isr page', () => {
  test('a route that declared NOTHING still keys on the whole query, as before', () => {
    expect(keyOf('/blog?x=1', null)).not.toBe(keyOf('/blog?x=2', null));
    expect(isrRequestUrl(at('/blog?x=1'), null).href).toBe('https://app.test/blog?x=1');
    expect(undeclaredQuery(at('/blog?x=1&y=2'), null)).toEqual(['x', 'y']);
  });

  test('query: [] keys on none: any query string is the one stored page', () => {
    const bare = keyOf('/blog', []);
    for (const path of ['/blog?x=1', '/blog?x=2', '/blog?utm_source=mail&fbclid=abc', '/blog?']) {
      expect(keyOf(path, [])).toBe(bare);
    }
    expect(isrRequestUrl(at('/blog?x=1#top'), []).href).toBe('https://app.test/blog');
  });

  test('only a declared parameter is part of the key, and of the URL load is given', () => {
    const declared = ['pagina'];
    expect(keyOf('/blog?pagina=2&utm_source=mail', declared)).toBe(
      keyOf('/blog?pagina=2', declared),
    );
    expect(keyOf('/blog?pagina=2', declared)).not.toBe(keyOf('/blog?pagina=3', declared));
    expect(keyOf('/blog?pagina=2', declared)).not.toBe(keyOf('/blog', declared));
    expect(isrRequestUrl(at('/blog?utm_source=mail&pagina=2'), declared).href).toBe(
      'https://app.test/blog?pagina=2',
    );
  });

  test('a repeated parameter keeps its first value, so repeats cannot mint entries', () => {
    const declared = ['pagina'];
    expect(keyOf('/blog?pagina=2&pagina=9', declared)).toBe(keyOf('/blog?pagina=2', declared));
    expect(keyOf('/blog?pagina=2&pagina=8', declared)).toBe(keyOf('/blog?pagina=2', declared));
  });

  test('declared parameters are ordered, whatever order the request or the route wrote them in', () => {
    expect(keyOf('/s?b=2&a=1', ['b', 'a'])).toBe(keyOf('/s?a=1&b=2', ['a', 'b']));
    expect(isrRequestUrl(at('/s?b=2&a=1'), ['b', 'a']).search).toBe('?a=1&b=2');
  });

  test('the locale the key carries cannot be chosen by the request', () => {
    expect(keyOf('/blog?__x_locale=es', [])).toBe(keyOf('/blog', []));
  });

  test('undeclaredQuery names what was dropped, once each', () => {
    expect(undeclaredQuery(at('/blog?utm_source=a&pagina=2&x=1&x=2'), ['pagina'])).toEqual([
      'utm_source',
      'x',
    ]);
    expect(undeclaredQuery(at('/blog?pagina=2'), ['pagina'])).toEqual([]);
  });
});
