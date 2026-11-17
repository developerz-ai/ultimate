// The one literal-segment compiler against the request router's own rule: a pathname segment is a
// route's literal when it IS the literal, or percent-decodes to it (`@ultimat3/http`'s trie).
import { describe, expect, test } from 'bun:test';
import { literalSegmentPattern } from './route-literal';

const matches = (literal: string, spelling: string): boolean =>
  new RegExp(`^${literalSegmentPattern(literal)}$`).test(spelling);

/** The router's rule, restated: the raw segment, or its decoding. */
const routerRoutes = (literal: string, spelling: string): boolean => {
  if (spelling === literal) return true;
  try {
    return decodeURIComponent(spelling) === literal;
  } catch {
    return false;
  }
};

/** [literal, a spelling a browser or `canonicalPath` writes for it, or one it must not own]. */
const CASES: readonly (readonly [string, string])[] = [
  ['a|b', 'a|b'],
  ['a|b', 'a%7Cb'],
  ['a|b', 'a%7cb'],
  ['a|b', 'a%7Db'],
  ['50%', '50%'],
  ['50%', '50%25'],
  ['50%', '50%2'],
  ['50%x|', '50%x%7C'],
  ['precios-españa', 'precios-españa'],
  ['precios-españa', 'precios-espa%C3%B1a'],
  ['precios-españa', 'precios-espa%c3%b1a'],
  ['precios-españa', 'precios-espa%C3%b1a'],
  ['precios-españa', 'precios-espa%C3%B2a'],
  ['precios-españa', 'precios-espana'],
  ['a b', 'a%20b'],
  ['a b', 'a b'],
  ['a%20b', 'a%20b'],
  ['a%20b', 'a%2520b'],
  ['a%20b', 'a b'],
  ['a.b(c)', 'a.b(c)'],
  ['a.b(c)', 'axb(c)'],
  ['😀', '%F0%9F%98%80'],
  ['posts', 'posts'],
];

describe('literalSegmentPattern', () => {
  test.each(CASES)(
    '%s owns %s exactly when the request router routes it there',
    (lit, spelling) => {
      expect(matches(lit, spelling)).toBe(routerRoutes(lit, spelling));
    },
  );

  test('owns the spelling `URL.pathname` and `encodeURIComponent` write, in either hex case', () => {
    for (const literal of ['a|b', 'a^b', '[x]', 'precios-españa', 'café', '{id}', 'a"b']) {
      const written = new URL(`https://x.invalid/${literal}`).pathname.slice(1);
      const component = encodeURIComponent(literal);
      for (const spelling of [written, component, component.toLowerCase()]) {
        expect([literal, spelling, matches(literal, spelling)]).toEqual([literal, spelling, true]);
      }
    }
  });

  test('an ASCII literal no writer escapes is its own pattern, regex-escaped', () => {
    expect(literalSegmentPattern('posts')).toBe('posts');
    expect(literalSegmentPattern('v1.0')).toBe(String.raw`v1\.0`);
  });

  // Decided: a character no writer escapes (`p`, `.`) is not matched escaped. The router still
  // routes `/%70osts`; the worker leaves it uncached and ISR never stores it (its keys are canonical).
  test('a gratuitous escape of an unreserved character is not owned', () => {
    expect(matches('posts', '%70osts')).toBe(false);
  });
});
