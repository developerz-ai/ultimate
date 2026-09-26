/**
 * The route table as the worker's rule list: which pattern, which strategy, which cache — ordered
 * most specific first, because the emitted `ruleFor` answers the FIRST match. Plus the asset rules
 * that are no route: content-addressed chunks, cached the first time a page asks for one.
 */

import { SwScopeInvalidError } from './errors';
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
 * How specifically a path claims a URL: a literal segment beats a `:param`, which beats a `*`.
 * The weights are `@ultimat3/render`'s `compilePattern`, verbatim (100 / 10 / 1), so the service
 * worker and the server rank the same pathname the same way.
 *
 * DUPLICATED, not imported: `render` and `pwa` are both tier 4 and a sideways import is a build
 * error. The shared home is `@ultimat3/core`'s `route-vocabulary.ts` — tier 0, already the owner of
 * `RENDER_MODES` / `OFFLINE_STRATEGIES` / `HYDRATE_STRATEGIES` for exactly this reason — and moving
 * it there is the follow-up this comment exists to name.
 */
function specificityOf(path: string): number {
  return segmentsOf(path).reduce((total, segment) => {
    if (segment.startsWith('*')) return total + 1;
    if (segment.startsWith(':')) return total + 10;
    return total + 100;
  }, 0);
}

/**
 * A catch-all is a FALLBACK, and it sorts behind every rule that is not one — a second key, because
 * a sum over segments cannot say it. `/` has no segments and so scores 0, while `/*rest` scores 1:
 * on specificity alone a single root catch-all outranks the home page, and with it every precached
 * entry in the table. The rule this expresses is the one a reader already assumes — a pattern that
 * matches everything answers only what nothing else claimed.
 */
const hasWildcard = (path: string): boolean =>
  segmentsOf(path).some((segment) => segment.startsWith('*'));

/**
 * Ordered MOST SPECIFIC FIRST, because the emitted `ruleFor` returns the first pattern that
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

export function routeRules(routes: readonly PwaRoute[]): readonly RouteRule[] {
  return [...routes]
    .filter((route) => route.surface !== 'api')
    .sort(
      (a, b) =>
        Number(hasWildcard(a.path)) - Number(hasWildcard(b.path)) ||
        specificityOf(b.path) - specificityOf(a.path) ||
        byCodeUnit(a.path, b.path),
    )
    .map((route) => {
      const strategy = strategyFor(route);
      return {
        pattern: toPattern(route.path),
        strategy,
        cache: cacheFor(route, strategy),
      };
    });
}

function cacheFor(route: PwaRoute, strategy: StrategyName): 'precache' | 'runtime' | 'pages' {
  if (strategy === 'network-only') return 'runtime';
  if (route.offline === 'precache' && route.dynamic !== true) return 'precache';
  return 'pages';
}

/**
 * A trailing slash is dropped before the pattern is built, because the pattern allows one anyway:
 * a locale's home is spelled `/en/`, and `^/en//?$` matched `/en/` and missed `/en`.
 */
function toPattern(path: string): string {
  const bare = path.replace(/\/+$/, '');
  if (bare === '') return '^/$';
  const body = bare
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '[^/]+';
      if (segment.startsWith('*')) return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
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
      pattern: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      strategy: 'cache-first',
      cache: 'runtime',
      asset: true,
    };
  });
}
