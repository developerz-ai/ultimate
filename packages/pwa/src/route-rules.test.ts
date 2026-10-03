// The route table as the worker's rules, resolved the way the emitted `ruleFor` resolves them:
// against a browser's `url.pathname`, which is percent-encoded, and in the cache the rule names.

import { describe, expect, test } from 'bun:test';
import type { RouteRule } from './route-rules';
import { routeRules } from './route-rules';
import type { PwaRoute } from './strategies';

/** What the emitted `ruleFor` does: the first rule whose pattern matches the PATHNAME. */
const ruleFor = (rules: readonly RouteRule[], href: string): RouteRule | undefined => {
  const { pathname } = new URL(href, 'https://app.test');
  return rules.find((rule) => new RegExp(rule.pattern).test(pathname));
};

const page = (path: string, extra: Partial<PwaRoute> = {}): PwaRoute => ({
  path,
  surface: 'site',
  mode: 'static',
  offline: 'runtime',
  ...extra,
});

/**
 * A route path is the DECODED directory name; `url.pathname` is what the browser percent-encoded.
 * A pattern built from the first never matched the second, so the worker never handled the page.
 */
describe('a pattern matches the pathname the browser sends', () => {
  test.each([
    ['/precios-españa', '/precios-españa'],
    ['/a b', '/a%20b'],
    ['/café/:id', '/caf%C3%A9/7'],
    ['/naïve', '/na%c3%afve'],
  ])('%s is handled at %s', (path, href) => {
    const rules = routeRules([page(path)]);
    expect(ruleFor(rules, href)?.pattern).toBe(rules[0]?.pattern);
  });

  test('a path already spelled encoded is not encoded twice', () => {
    const rules = routeRules([page('/a%20b')]);
    expect(ruleFor(rules, '/a%20b')).toBeDefined();
    expect(ruleFor(rules, '/a%2520b')).toBeUndefined();
  });

  test('a character the browser leaves alone stays literal — and regex-escaped', () => {
    const rules = routeRules([page('/a|b'), page('/v1.0')]);
    expect(ruleFor(rules, '/a|b')?.pattern).toBe(String.raw`^/a\|b/?$`);
    expect(ruleFor(rules, '/a')).toBeUndefined();
    expect(ruleFor(rules, '/v1x0')).toBeUndefined();
  });

  test('an ASCII path is unchanged', () => {
    expect(routeRules([page('/posts/:id')]).map((rule) => rule.pattern)).toEqual([
      '^/posts/[^/]+/?$',
    ]);
  });
});

/** `static-path.ts` writes `/docs` for an empty `*path`, so the worker must route it too. */
describe('a catch-all', () => {
  const rules = routeRules([page('/docs/*path')]);

  test.each(['/docs', '/docs/', '/docs/a', '/docs/a/b/'])('matches %s', (href) => {
    expect(ruleFor(rules, href)).toBeDefined();
  });

  test.each(['/docsx', '/doc', '/', '/other/docs'])('does not match %s', (href) => {
    expect(ruleFor(rules, href)).toBeUndefined();
  });

  test('at the root it matches the root and everything under it', () => {
    const root = routeRules([page('/*rest')]);
    for (const href of ['/', '/a', '/a/b']) expect(ruleFor(root, href)).toBeDefined();
  });

  test('in the middle it still requires what follows it', () => {
    const middle = routeRules([page('/a/*mid/end')]);
    expect(ruleFor(middle, '/a/end')).toBeDefined();
    expect(ruleFor(middle, '/a/x/y/end')).toBeDefined();
    expect(ruleFor(middle, '/a/x')).toBeUndefined();
  });
});

/**
 * Which cache a rule writes is a privacy decision: `precache` and `runtime` are shared and guarded
 * (a private answer is dropped), `pages` is the facade that, in `last-member`, files a private answer
 * under its member's own partition. A personal page is never in the precache manifest, so a
 * `precache` rule for it was a cache that always missed — the page was never kept for offline.
 */
describe('the cache a rule names', () => {
  const signedIn = page('/dashboard', {
    surface: 'app',
    mode: 'ssr',
    offline: 'precache',
    personal: true,
  });
  const signedInRuntime = { ...signedIn, path: '/inbox', offline: 'runtime' as const };
  const pub = page('/pricing', { offline: 'precache' });
  const mixed = page('/feed', { surface: 'app', mode: 'ssr' });
  const cacheOf = (rules: readonly RouteRule[], href: string) => ruleFor(rules, href)?.cache;

  test("'last-member': a personal page is a pages rule, whatever its offline mode", () => {
    const rules = routeRules([signedIn, signedInRuntime, pub, mixed], 'last-member');
    expect(cacheOf(rules, '/dashboard')).toBe('pages');
    expect(ruleFor(rules, '/dashboard')?.strategy).toBe('network-first');
    expect(cacheOf(rules, '/inbox')).toBe('pages');
  });

  test("'last-member' leaves a public page and a mixed route where they were", () => {
    const rules = routeRules([signedIn, pub, mixed], 'last-member');
    expect(cacheOf(rules, '/pricing')).toBe('precache');
    expect(cacheOf(rules, '/feed')).toBe('pages');
  });

  test("'never' (the default): a personal page is network-only, in no shared cache", () => {
    for (const rules of [routeRules([signedIn, pub]), routeRules([signedIn, pub], 'never')]) {
      expect(ruleFor(rules, '/dashboard')?.strategy).toBe('network-only');
      expect(cacheOf(rules, '/dashboard')).toBe('runtime');
      expect(cacheOf(rules, '/pricing')).toBe('precache');
    }
  });

  test("'never': a personal page with a strategy override is still never a precache rule", () => {
    const rules = routeRules([{ ...signedIn, strategy: 'network-first' }]);
    expect(cacheOf(rules, '/dashboard')).toBe('pages');
  });
});

/**
 * The emitted `ruleFor` answers the FIRST matching rule, so the sort IS the routing decision, and
 * it must be the request router's: segment by segment, literal over `:param` over `*catch-all`, a
 * pattern that has ENDED over all three. `@ultimat3/render`'s `compilePattern` documents the same
 * rule (`route-pattern.ts`); pwa cannot import it (tier 4, sideways), so these fixtures are written
 * from that rule by hand — the parity check is against the rule, not against render's code.
 */
describe('rule order is the request router’s', () => {
  const winner = (paths: readonly string[], href: string): string | undefined => {
    const rules = routeRules(paths.map((path) => page(path)));
    const pattern = ruleFor(rules, href)?.pattern;
    return paths.find((path) => routeRules([page(path)])[0]?.pattern === pattern);
  };

  test('/a/b/c is /a/:x/:y, never /:a/b/c — the first differing segment decides, not a sum', () => {
    expect(winner(['/:a/b/c', '/a/:x/:y'], '/a/b/c')).toBe('/a/:x/:y');
    expect(winner(['/a/:x/:y', '/:a/b/c'], '/a/b/c')).toBe('/a/:x/:y');
  });

  // [pathname, the patterns that all match it, the one the router answers with]
  const PARITY: readonly (readonly [string, readonly string[], string])[] = [
    ['/posts/new', ['/posts/:id', '/posts/new', '/*rest'], '/posts/new'],
    ['/posts/42', ['/posts/:id', '/*rest'], '/posts/:id'],
    ['/a/x', ['/:p/x', '/a/*rest'], '/a/*rest'],
    ['/a/b', ['/a/*rest', '/a/:b'], '/a/:b'],
    ['/docs', ['/docs/*path', '/docs'], '/docs'],
    ['/', ['/*rest', '/'], '/'],
    ['/acme/settings', ['/:tenant/settings', '/acme/:page', '/acme/settings'], '/acme/settings'],
    ['/acme/x', ['/:tenant/:page', '/acme/:page'], '/acme/:page'],
    ['/a/b/c/d', ['/:a/:b/c/d', '/a/:b/*rest'], '/a/:b/*rest'],
    ['/x/y', ['/:a/*rest', '/*rest'], '/:a/*rest'],
  ];

  test.each(PARITY)('%s → the router’s pick', (href, paths, expected) => {
    expect(winner(paths, href)).toBe(expected);
    expect(winner([...paths].reverse(), href)).toBe(expected);
  });

  test('ties keep the code-unit order, so the emitted file is byte-stable', () => {
    expect(routeRules([page('/beta'), page('/alpha')]).map((rule) => rule.pattern)).toEqual([
      '^/alpha/?$',
      '^/beta/?$',
    ]);
  });
});
