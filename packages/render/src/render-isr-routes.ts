/**
 * Which route a stored `isr` key belongs to, and what that route declared about it — its tags, its
 * TTL, what an invalidation does and how long past its TTL a copy may still be served. Split from
 * `render-isr.ts`: the controller asks, this file reads the route table.
 */

import type { CacheTag } from '@ultimat3/cache';
import { parseTtlMs } from './duration';
import type { RouteDescriptor } from './registry';
import { routePathOf } from './render-isr-key';
import type { InvalidateMode } from './route';
import { compilePattern } from './route-pattern';

/** `post` / `post:123` → `{ entity, id? }`. Mirrors `@ultimat3/cache`'s wire form. */
export function parseWireTag(wire: string): CacheTag {
  const split = wire.indexOf(':');
  if (split === -1) return { entity: wire };
  return { entity: wire.slice(0, split), id: wire.slice(split + 1) };
}

/** What a route declared for the entries stored under it; the defaults for a key no route owns. */
export interface IsrPolicy {
  readonly tags: readonly CacheTag[];
  readonly ttlMs: number | null;
  /** `'stale'`: a bust keeps the copy for one more serve. `'purge'`: a bust deletes it. */
  readonly onInvalidate: InvalidateMode;
  /** How long past its TTL an entry may still be served stale; `null` is unbounded. */
  readonly maxStaleMs: number | null;
}

export function isrPolicyOf(descriptor: RouteDescriptor | undefined): IsrPolicy {
  return {
    tags: (descriptor?.revalidateTags ?? []).map(parseWireTag),
    ttlMs: parseTtlMs(descriptor?.revalidateTtl),
    onInvalidate: descriptor?.revalidateOnInvalidate ?? 'stale',
    maxStaleMs: parseTtlMs(descriptor?.revalidateMaxStale),
  };
}

interface RouteMatcher {
  readonly route: RouteDescriptor;
  test(storedPath: string): boolean;
}

/** One compiled set per route TABLE — `describePages()` hands out one array per registry change. */
const compiledTables = new WeakMap<readonly RouteDescriptor[], readonly RouteMatcher[]>();

/**
 * A stored path belongs to a route when the route's pattern matches it — `route-pattern.ts`'s one
 * pattern compiler, never a second. Ordered MOST SPECIFIC FIRST, as `@ultimat3/http`'s trie
 * resolves a request: segment by segment, a static beats a `:param` beats a `*catch-all`. In table
 * order `/docs/*path` sorts before `/docs/:id`, so the first match gave `/docs/7` the catch-all's
 * TTL and tags — a page rendered by one route and expired by another's clock.
 */
function matchersOf(table: readonly RouteDescriptor[]): readonly RouteMatcher[] {
  const cached = compiledTables.get(table);
  if (cached !== undefined) return cached;
  // Static routes too: `/precios-españa` is the route's path and `/precios-espa%C3%B1a` the key's,
  // so only the pattern (raw or encoded, per character) finds it.
  const compiled = table
    .map((route): RouteMatcher & { readonly specificity: number } => {
      const { regex, specificity } = compilePattern(route.path);
      return { route, specificity, test: (stored) => regex.test(stored) };
    })
    .sort((a, b) => b.specificity - a.specificity);
  compiledTables.set(table, compiled);
  return compiled;
}

/** The route a store key was rendered by, or `undefined` for a key no route in `table` owns. */
export function isrRouteFor(
  table: readonly RouteDescriptor[],
  key: string,
): RouteDescriptor | undefined {
  const path = routePathOf(key);
  return table.find((r) => r.path === path) ?? matchersOf(table).find((m) => m.test(path))?.route;
}
