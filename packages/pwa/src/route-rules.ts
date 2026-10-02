/**
 * The route table as the worker's rule list: which pattern, which strategy, which cache — ordered
 * most specific first, because the emitted `ruleFor` answers the FIRST match. Plus the asset rules
 * that are no route: content-addressed chunks, cached the first time a page asks for one.
 */

import { routeRank } from '@ultimat3/core';
import { SwScopeInvalidError } from './errors';
import type { PersonalPages } from './pages-cache-source';
import type { PwaRoute, StrategyName } from './strategies';
import { strategyFor } from './strategies';

export interface RouteRule {
  readonly pattern: string;
  readonly strategy: StrategyName;
  readonly cache: 'precache' | 'runtime' | 'pages';
  /**
   * An asset prefix, not a page: fetched as the browser asked (no build-id header — a classic
   * script is a `no-cors` request, whose headers a worker may not extend) and never warmed.
   */
  readonly asset?: true;
}

const segmentsOf = (path: string): readonly string[] =>
  path.split('/').filter((segment) => segment.length > 0);

/**
 * Ordered MOST SPECIFIC FIRST — `@ultimat3/core`'s `routeRank`, the one rule `@ultimat3/render` and
 * the request router share — because the emitted `ruleFor` returns the first pattern that
 * matches and has no notion of specificity of its own. Sorted alphabetically it did not: `:` (0x3A)
 * and `*` (0x2A) both sort before every letter, so `/posts/:id` shadowed `/posts/new` and a single
 * `/*` catch-all shadowed the entire table — every entry in `PRECACHE_MANIFEST` downloaded at
 * install and then never looked up, and a route the app declared cacheable served `network-only`,
 * which offline is the `/offline` document.
 *
 * The path stays as the tie-break, so the emitted file is still byte-identical for identical input
 * — compared by CODE UNIT, never `localeCompare`, which answers from the runtime's ICU default and
 * collation version: `/Posts` sorted before `/posts` on one machine and after it on the next, for
 * the same route table. The rule `@ultimat3/jobs`' `job.ts` states for `x.manifest.json`, applied
 * to the artifact this file emits.
 */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `personalPages: 'last-member'` routes a personal page by its render mode again — the pages facade
 * partitions it per member. `'never'` (the default) leaves it `network-only`.
 */
export function routeRules(
  routes: readonly PwaRoute[],
  personalPages: PersonalPages = 'never',
): readonly RouteRule[] {
  return [...routes]
    .filter((route) => route.surface !== 'api')
    .sort((a, b) => routeRank(b.path) - routeRank(a.path) || byCodeUnit(a.path, b.path))
    .map((route) => {
      const strategy = strategyFor(
        personalPages === 'last-member' ? { ...route, personal: false } : route,
      );
      return {
        pattern: toPattern(route.path),
        strategy,
        cache: cacheFor(route, strategy),
      };
    });
}

/**
 * A personal page that reaches a cache at all goes to `pages`, never `precache`: it is never in the
 * precache manifest (fetched anonymously at install it is a sign-in redirect), so a `precache` rule
 * was a cache that always missed — and only the pages facade files a member's page by member.
 */
function cacheFor(route: PwaRoute, strategy: StrategyName): 'precache' | 'runtime' | 'pages' {
  if (strategy === 'network-only') return 'runtime';
  if (route.personal === true) return 'pages';
  if (route.offline === 'precache' && route.dynamic !== true) return 'precache';
  return 'pages';
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A literal segment as the browser's `url.pathname` spells it — the WHATWG serializer itself, so a
 * route path (the DECODED directory name) matches the PERCENT-ENCODED pathname `ruleFor` tests:
 * `/precios-españa` and `/a b` were never handled. Not `encodeURI`, which also escapes `|`, `[`,
 * `^` and `%` where a browser leaves them literal. A `%XX` escape matches either hex case, as a
 * hand-typed link may carry one.
 */
function literal(segment: string): string {
  const url = new URL('https://x.invalid/');
  url.pathname = `/${segment}`;
  return escapeRegex(url.pathname.slice(1)).replace(
    /%([0-9A-Fa-f]{2})/g,
    (_, hex: string) =>
      `%${[...hex].map((c) => (/[A-Fa-f]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)).join('')}`,
  );
}

/**
 * A trailing slash is dropped before the pattern is built, because the pattern allows one anyway:
 * a locale's home is spelled `/en/`, and `^/en//?$` matched `/en/` and missed `/en`. A catch-all
 * takes its leading slash with it, `(?:/.*)?`, so `/docs/*path` matches the bare `/docs` that
 * `@ultimat3/render`'s static export writes for an empty `path`.
 */
function toPattern(path: string): string {
  const segments = segmentsOf(path);
  if (segments.length === 0) return '^/$';
  const body = segments
    .map((segment) => {
      if (segment.startsWith(':')) return '/[^/]+';
      if (segment.startsWith('*')) return '(?:/.*)?';
      return `/${literal(segment)}`;
    })
    .join('');
  return `^${body}/?$`;
}

/**
 * `runtimeAssets` as rules, AHEAD of every page rule: a prefix like `/islands/` names
 * content-addressed chunks, so the first copy is the only copy and `cache-first` is exact. They are
 * what the precache leaves out — every island in the app was precached, so a first anonymous visit
 * downloaded the admin, KYC and payment islands too (~1 MB on notificado.co, 22.3.2).
 */
export function assetRules(prefixes: readonly string[], scope: string): readonly RouteRule[] {
  return [...new Set(prefixes)].sort(byCodeUnit).map((prefix) => {
    if (!prefix.startsWith(scope)) {
      throw new SwScopeInvalidError(
        `runtime asset prefix ${JSON.stringify(prefix)} is not an absolute path under the ` +
          `worker's scope ${scope}, so no request pathname would ever match it`,
        `name the prefix as the browser requests it, e.g. '${scope}islands/'`,
      );
    }
    return {
      pattern: `^${escapeRegex(prefix)}`,
      strategy: 'cache-first',
      cache: 'runtime',
      asset: true,
    };
  });
}
