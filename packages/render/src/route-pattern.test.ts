// `compilePattern`'s regex against the pathnames a URL actually carries: a catch-all with an empty
// rest is the bare prefix `static-path.ts` writes (`/docs`), and a literal segment outside ASCII
// arrives percent-encoded (`URL.pathname`), in either hex case, or raw.
import { describe, expect, test } from 'bun:test';
import { routeRank } from '@ultimat3/core';
import { fillPath } from './render-static';
import { compilePattern } from './route-pattern';

describe('a catch-all with an empty rest', () => {
  test('matches the bare prefix the static build writes for it', () => {
    const { regex } = compilePattern('/docs/*path');
    expect(fillPath('/docs/*path', {})).toBe('/docs');
    expect(regex.test('/docs')).toBe(true);
    expect(regex.exec('/docs/')?.[1]).toBe('');
    expect(regex.exec('/docs/a/b')?.[1]).toBe('a/b');
  });

  test('is still bounded by its prefix segment', () => {
    const { regex } = compilePattern('/docs/*path');
    for (const path of ['/docsx', '/docsx/a', '/doc', '/']) expect(regex.test(path)).toBe(false);
  });

  test('at the root, matches the root and everything under it', () => {
    const { regex } = compilePattern('/*path');
    for (const path of ['/', '/a', '/a/b']) expect(regex.test(path)).toBe(true);
  });

  test('a param before it still needs its own segment', () => {
    const { regex } = compilePattern('/u/:id/*rest');
    expect(regex.exec('/u/7')?.[1]).toBe('7');
    expect(regex.exec('/u/7/a/b')?.slice(1, 3)).toEqual(['7', 'a/b']);
    expect(regex.test('/u')).toBe(false);
  });
});

describe('a literal segment outside ASCII', () => {
  const { regex } = compilePattern('/precios-españa/:slug');

  test('matches the pathname a URL carries, percent-encoded', () => {
    const pathname = new URL('https://app.test/precios-españa/x').pathname;
    expect(pathname).toBe('/precios-espa%C3%B1a/x');
    expect(regex.exec(pathname)?.[1]).toBe('x');
  });

  test('matches it raw, and with lower-case hex', () => {
    expect(regex.test('/precios-españa/x')).toBe(true);
    expect(regex.test('/precios-espa%c3%b1a/x')).toBe(true);
  });

  test('never matches another spelling', () => {
    expect(regex.test('/precios-espana/x')).toBe(false);
    expect(regex.test('/precios-espa%C3%B2a/x')).toBe(false);
  });

  test('a regex metacharacter in a literal is matched as itself', () => {
    const literal = compilePattern('/a.b(c)/:id').regex;
    expect(literal.test('/a.b(c)/1')).toBe(true);
    expect(literal.test('/axb(c)/1')).toBe(false);
  });
});

describe('specificity', () => {
  // The rule itself is `@ultimat3/core`'s, tested there (`route-rank.test.ts`); this pins that
  // `compilePattern` carries it rather than a rule of its own.
  test.each(['/', '/docs', '/docs/:slug', '/docs/*path', '/a/:x/:y', '/:a/b/c'])(
    '%s is ranked by routeRank',
    (path) => {
      expect(compilePattern(path).specificity).toBe(routeRank(path));
    },
  );
});
