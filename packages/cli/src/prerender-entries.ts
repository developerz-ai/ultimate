// The pages each public `site/` route's `prerender()` lists, enumerated ONCE by the static export
// while its in-process API scope and database are still open — and handed to `siteSeo` on the
// report, so the sitemap never asks `prerender()` again after the build released both.

import type { PrerenderEntry, RouteEntry } from '@ultimat3/render';
import { enumeratePrerenderEntries } from '@ultimat3/render/server';

/** Every route's enumeration, by its DECLARED path (`/posts/:slug`). */
export type RouteEntries = ReadonlyMap<string, readonly PrerenderEntry[]>;

export type EnumerateRoute = (entry: RouteEntry) => Promise<readonly PrerenderEntry[]>;

/**
 * `enumeratePrerenderEntries`, asked at most once per route: the build hands the one memo to the
 * weigh-only branch (`measurePaths`) and to `enumerateRoutes`, so a budgeted dynamic route's
 * `prerender()` runs once per build.
 */
export function enumerateOnce(): EnumerateRoute {
  const asked = new Map<string, Promise<readonly PrerenderEntry[]>>();
  return (entry) => {
    const known = asked.get(entry.path);
    if (known !== undefined) return known;
    const answer = enumeratePrerenderEntries(entry);
    asked.set(entry.path, answer);
    return answer;
  };
}

/**
 * A route `siteSeo` would ask: public `site/` with a `prerender()` declared. One without has
 * nothing to enumerate (`enumeratePrerenderEntries` answers from the pattern alone), so an app with
 * none starts no database for it.
 */
export const asksPrerender = (entry: RouteEntry): boolean =>
  entry.surface === 'site' &&
  entry.config.policy === undefined &&
  entry.config.prerender !== undefined;

/**
 * Each of `routes` that `asksPrerender`, enumerated in turn inside `scope` — the build's measuring
 * scope, where a `prerender()` reading the app's own query is answered. A throw is the build's
 * failure, exactly as it was when the sitemap made the call: a `prerender()` that cannot list its
 * pages is the app's bug, never a page silently left out.
 */
export async function enumerateRoutes(
  routes: readonly RouteEntry[],
  scope: <T>(fn: () => Promise<T>) => Promise<T>,
  before: () => Promise<void>,
  enumerate: EnumerateRoute = enumeratePrerenderEntries,
): Promise<RouteEntries> {
  const asked = routes.filter(asksPrerender);
  const entries = new Map<string, readonly PrerenderEntry[]>();
  if (asked.length === 0) return entries;
  await before();
  for (const entry of asked) {
    entries.set(entry.path, await scope(() => enumerate(entry)));
  }
  return entries;
}
