/**
 * `isr` — static output plus background regeneration. Three things make it safe:
 * stale-while-revalidate (a stale page is served instantly, never a spinner),
 * single-flight regeneration (a traffic burst on a stale page renders once, not N times),
 * and tag-driven staleness (an action's `invalidates` marks exactly the dependent routes).
 */

import type { CacheTag, Revalidator } from '@ultimat3/cache';
import {
  dependentsOfKind,
  invalidateTags,
  markInvalidated,
  registerDependent,
  registerRevalidator,
  sampleFence,
  surrogateKeys,
  unregisterDependent,
} from '@ultimat3/cache';
import type { Scheduler } from '@ultimat3/core';
import { finiteCount, logger, renderThrowable, singleFlight } from '@ultimat3/core';
import { unlocalizedPath } from '@ultimat3/i18n';
import { parseTtlMs } from './duration';
import { finiteStatus, isRenderStatus } from './finite-status';
import type { RouteDescriptor } from './registry';
import { describePages } from './registry';
import type { IsrEntry, IsrState, IsrStore } from './render-isr-store';
import { memoryIsrStore } from './render-isr-store';
import { contentHash, staticHeaders } from './render-static';
import type { RenderResult } from './route';
import { compilePattern } from './route-pattern';

/**
 * The reserved query parameter the negotiated locale rides in. A parameter and not a prefix
 * because `routePathOf` splits a key at its `?`: a `es:/blog` key would match no route, so
 * `descriptorFor` would answer `undefined` and a declared `revalidate: { ttl }` would silently
 * become tag-only. Reserved spelling, so an app's own `?locale=` stays its own dimension.
 */
export const ISR_LOCALE_PARAM = '__x_locale';

/**
 * The ISR store key for one request URL: pathname, the negotiated LOCALE, and the query, **params
 * sorted**.
 *
 * Exported because deriving it is the caller's job and there may only be ONE derivation — a
 * server that keyed on `url.pathname` while the store believed it held a whole URL is the shape
 * of #171. Sorting makes `?a=1&b=2` and `?b=2&a=1` one entry rather than two renders of one page.
 *
 * The locale is REQUIRED, and required as an argument rather than read from the ambient context so
 * that every call site has to answer: a document is rendered with `<html lang>` and every `t()` in
 * the request's own locale, so one entry per path served visitor 2 the document negotiated for
 * visitor 1 — for the whole TTL, and with `s-maxage` telling the CDN to do the same. The time zone
 * is deliberately NOT a dimension: it is unbounded where a locale set is declared, and an `isr`
 * page is a shared artifact, so a date on one belongs in an explicit zone the page itself names.
 *
 * A query-carrying URL therefore gets its own entry, which is correct and is not free: a crawler
 * appending `?utm_source=…` mints one entry per value. That is bounded, not unbounded —
 * `DEFAULT_ISR_MAX_ENTRIES` evicts least-recently-generated first — and a bounded cache that
 * thrashes is the right failure next to an unbounded one that answers the wrong document.
 */
export function isrKey(url: URL, locale: string): string {
  const params = new URLSearchParams(url.search);
  params.set(ISR_LOCALE_PARAM, locale);
  params.sort();
  return `${url.pathname}?${params.toString()}`;
}

/**
 * The path the ROUTE TABLE knows a key by. Every lookup that asks the table a question — the
 * descriptor, and therefore the TTL and the tags — has to undo what the key carries beyond the
 * route, in the order the router does before it matches (`@ultimat3/http`'s `routing` stage):
 *
 * - the query: `descriptorFor('/blog?page=2')` matches no route;
 * - the routed locale prefix: `/en/blog/a` is the `/blog/:slug` route in English. The key KEEPS the
 *   prefix — it is the URL the document was rendered for, `canonical` and all — and the table has
 *   never heard of it. Left on, a prefixed page matched no route: `ttlMs: null` and no tag edge, so
 *   it was fresh forever while the default locale's copy of the same page went stale on schedule.
 *
 * `unlocalizedPath` is i18n's, the one the router's own split is built on: a segment that names no
 * routed locale is left alone, so `/fr/blog` is still no route.
 */
function routePathOf(key: string): string {
  const query = key.indexOf('?');
  return unlocalizedPath(query === -1 ? key : key.slice(0, query));
}

/**
 * A render that also answers a status — what a loader's `withStatus(404, …)` becomes once the
 * document is built. A bare string is the 200 every render before this one was: the union is
 * additive, and a render function that never learned the object shape keeps compiling.
 */
export interface IsrRendered {
  readonly html: string;
  readonly status: number;
}

export type IsrRenderFn = (path: string) => string | IsrRendered | Promise<string | IsrRendered>;

/** One shape for the generator, so nothing below branches on what the render handed back. */
function renderedOf(rendered: string | IsrRendered): IsrRendered {
  return typeof rendered === 'string' ? { html: rendered, status: 200 } : rendered;
}

export interface IsrServeResult {
  readonly state: IsrState;
  readonly entry: IsrEntry;
  readonly result: RenderResult;
  /** True when this request started a background regeneration. */
  readonly regenerating: boolean;
}

export interface IsrControllerOptions {
  readonly store?: IsrStore;
  readonly buildId?: string;
  readonly now?: () => number;
  /** Route table provider — defaults to the real registry. */
  readonly routes?: () => readonly RouteDescriptor[];
  /** ISR-route dependents for a tag set; defaults to `@ultimat3/cache`'s graph. */
  readonly isrDependents?: (tags: readonly CacheTag[]) => readonly string[];
  /**
   * How long one regeneration may hold its path, in whole ms (≥ 1). Defaults to
   * `DEFAULT_ISR_REGENERATE_DEADLINE_MS`. There is no "forever": that is the bug it bounds.
   */
  readonly regenerateDeadlineMs?: number | undefined;
  /** Injected so the deadline is provable without waiting one out. */
  readonly schedule?: Scheduler | undefined;
}

/**
 * The ceiling on one regeneration's hold on its path — `@ultimat3/http`'s default
 * `requestTimeoutMs`, so the request that started a render has been cut off by then. Without it,
 * one `render()` that never settled pinned its path for the life of the process: a missed page
 * hung every later request, a stale one was served stale forever, and only a restart cleared it.
 * Eviction frees the PATH; the hung render is not cancellable from here, and its late result is
 * dropped if a newer regeneration has started since (`latest`).
 */
export const DEFAULT_ISR_REGENERATE_DEADLINE_MS = 30_000;

export interface IsrController {
  serve(path: string, render: IsrRenderFn): Promise<IsrServeResult>;
  /** Single-flight: concurrent callers for the same path share one render. */
  regenerate(path: string, render: IsrRenderFn): Promise<IsrEntry>;
  markStale(path: string): boolean;
  /** Mark every ISR page the cache graph says depends on these tags. */
  revalidateByTags(tags: readonly CacheTag[]): readonly string[];
  inflight(): number;
  store(): IsrStore;
  /**
   * Register this controller as the framework's revalidator, so
   * `action({ cache: { invalidates: [tag.post] } })` reaches ISR in the same hop as
   * memo, LRU, Redis and the CDN. Returns a detach function for tests and reloads.
   */
  attach(): () => void;
}

/**
 * `@ultimat3/cache` holds ONE revalidator and offers no read back, so detaching has to know
 * whether the slot is still this controller's — a controller that attached after it owns it now.
 */
let installedRevalidator: Revalidator | undefined;

/** What `registerRevalidator` is handed on detach: the framework's "nothing to revalidate". */
const NO_REVALIDATION: Revalidator = () => undefined;

export function isrController(options: IsrControllerOptions = {}): IsrController {
  const store = options.store ?? memoryIsrStore();
  const now = options.now ?? (() => Date.now());
  const routes = options.routes ?? describePages;
  const isrDependents =
    options.isrDependents ?? ((tags: readonly CacheTag[]) => dependentsOfKind(tags, 'isr-route'));
  const buildId = options.buildId ?? 'dev';
  const flight = singleFlight({
    deadlineMs: finiteCount(
      'isrController',
      'regenerateDeadlineMs',
      options.regenerateDeadlineMs ?? DEFAULT_ISR_REGENERATE_DEADLINE_MS,
      1,
    ),
    schedule: options.schedule,
  });
  /**
   * The newest regeneration STARTED per path, by identity. Once a deadline can evict a flight, two
   * renders of one path can overlap, and the older one settling last would publish its HTML over
   * the newer page with a fresh `generatedAt`. Cleared by the run that still owns it; a run that
   * never settles leaves one entry, replaced by the next regeneration of that path.
   */
  const latest = new Map<string, object>();
  const registered = new Set<string>();

  function descriptorFor(key: string): RouteDescriptor | undefined {
    const path = routePathOf(key);
    const table = routes();
    return table.find((r) => r.path === path) ?? matchersOf(table).find((m) => m.test(path))?.route;
  }

  /** The route's `revalidate.tags` for a store key — what its document is purged by at the edge. */
  const tagsOf = (key: string): readonly CacheTag[] =>
    (descriptorFor(key)?.revalidateTags ?? []).map(parseWireTag);

  /**
   * A rendered page joins the invalidation graph under its route's tags, so `/blog/a` and
   * `/blog/b` are separately addressable and a `tag.post` bust does not touch `/team`.
   */
  function registerPath(path: string, descriptor: RouteDescriptor | undefined): void {
    if (descriptor === undefined || registered.has(path)) return;
    if (descriptor.revalidateTags.length === 0) return;
    registerDependent(descriptor.revalidateTags.map(parseWireTag), { kind: 'isr-route', id: path });
    registered.add(path);
  }

  /**
   * A registration is only true while the store still holds the page. The store evicts silently
   * and offers no callback — and a custom `IsrStore` need not have one at all — so the store's own
   * `paths()` is the authority, reconciled after every generation. Left alone, `registered` and
   * the cache graph behind it only ever grew: `/blog/:slug` retains one edge per slug ever
   * requested, 404-shaped ones included, for the life of the process.
   */
  function forgetEvictedPaths(): void {
    if (registered.size === 0) return;
    const live = new Set(store.paths());
    for (const path of registered) {
      if (live.has(path)) continue;
      unregisterDependent({ kind: 'isr-route', id: path });
      registered.delete(path);
    }
  }

  function isFresh(entry: IsrEntry): boolean {
    if (entry.stale) return false;
    const ttlMs = entryTtlMs(entry);
    if (ttlMs === null) return true; // tag-only revalidation: fresh until invalidated
    return now() - entry.generatedAt < ttlMs;
  }

  /** One regeneration of `path`; `led` is told when THIS call started it rather than joined one. */
  function regenerateOnce(path: string, render: IsrRenderFn, led?: () => void): Promise<IsrEntry> {
    return flight.run(path, async (): Promise<IsrEntry> => {
      led?.();
      const run = {};
      latest.set(path, run);
      const descriptor = descriptorFor(path);
      try {
        // BEFORE the render, not after: `revalidateByTags` reads the graph, so a bust arriving
        // while a cold path's first render was in flight could not see the page it was
        // invalidating — which is the window in which the bust that matters most arrives.
        registerPath(path, descriptor);
        // Sampled before the render for the reason `@ultimat3/cache`'s read-through fill samples
        // before its `load()` (`tiers.ts`): the HTML below is built from rows read in the past,
        // and a `markStale` landing in between was then ERASED by `store.set({ stale: false })`.
        // For a tag-only route `isFresh` is true forever, so the process went on serving pre-write
        // HTML for the rest of its life. One mechanism, not a second one grown here.
        const fence = sampleFence({
          key: path,
          tags: (descriptor?.revalidateTags ?? []).map(parseWireTag),
        });
        const { html, status } = renderedOf(await render(path));
        const entry: IsrEntry = {
          path,
          html,
          hash: contentHash(html),
          generatedAt: now(),
          ttlMs: parseTtlMs(descriptor?.revalidateTtl),
          stale: false,
          // Screened at generation, the one place a status enters the store: a `NaN` written here
          // would be served for the whole TTL as a `RangeError` on every hit.
          status: finiteStatus('IsrRenderFn', status),
        };
        // Refused, never published stale-flagged: the next request re-renders from rows that now
        // include the write, where a stored-but-stale entry would serve this pre-write body once
        // more before doing the same thing. Refused too once a newer run started (`latest`).
        if (fence.isValid() && latest.get(path) === run) store.set(entry);
        forgetEvictedPaths();
        return entry;
      } finally {
        if (latest.get(path) === run) latest.delete(path);
      }
    });
  }

  function regenerate(path: string, render: IsrRenderFn): Promise<IsrEntry> {
    return regenerateOnce(path, render);
  }

  function markStale(path: string): boolean {
    // The mark is recorded whether or not the store holds the page: a regeneration already in
    // flight for a path this store has never held is exactly the case the fence above exists for,
    // and `invalidateTags`' own fanout only marks the TAGS.
    markInvalidated({ key: path });
    return store.markStale(path);
  }

  return {
    store: () => store,
    inflight: () => flight.size,
    regenerate,
    markStale,

    async serve(path, render) {
      const cached = store.get(path);

      if (cached === undefined) {
        const entry = await regenerate(path, render);
        const result = toResult(entry, buildId, tagsOf(path));
        return { state: 'miss', entry, result, regenerating: false };
      }

      if (isFresh(cached)) {
        return {
          state: 'hit',
          entry: cached,
          result: toResult(cached, buildId, tagsOf(path)),
          regenerating: false,
        };
      }

      // stale-while-revalidate: answer from the stale copy now, refresh behind the request.
      let started = false;
      void regenerateOnce(path, render, () => {
        started = true;
      }).catch((error: unknown) => {
        // `renderThrowable`, never `.message`/`String()`: this `.catch` is the last frame under a
        // route's own render function, and `String()` raises on a null-prototype object — the
        // handler that exists to REPORT the failure became a second, unhandled rejection.
        logger.warn('isr.regenerate.failed', { path, error: renderThrowable(error) });
      });
      return {
        state: 'stale',
        entry: cached,
        result: toResult(cached, buildId, tagsOf(path), true),
        regenerating: started,
      };
    },

    revalidateByTags(tags) {
      const affected = new Set<string>();
      for (const path of isrDependents(tags)) {
        markStale(path);
        affected.add(path);
      }
      return [...affected].sort();
    },

    attach() {
      // The cache fanout owns the trigger; render owns only "what does stale mean here".
      const revalidate: Revalidator = (path) => {
        markStale(path);
      };
      registerRevalidator(revalidate);
      installedRevalidator = revalidate;
      return () => {
        for (const path of registered) unregisterDependent({ kind: 'isr-route', id: path });
        registered.clear();
        // Left installed, this closure — and the whole store behind it — stayed reachable from
        // the cache graph and kept receiving revalidations. `x dev`'s hot reload detached A and
        // created B, and `invalidateTags` still called A's `markStale`: B's pages never went
        // stale and A's store was never collected. Only if the slot is still OURS: a controller
        // that attached after us owns it, and clearing that one is this bug pointed backwards.
        if (installedRevalidator === revalidate) {
          registerRevalidator(NO_REVALIDATION);
          installedRevalidator = undefined;
        }
      };
    },
  };
}

/**
 * The whole loop, in one call: `action({ cache: { invalidates: [tag.post] } })` fans out
 * across memo, LRU, Redis and the CDN, and the same hop returns the ISR pages that were
 * marked stale — because the controller registered them in the same graph. Nobody lists
 * pages by hand, so nobody forgets one.
 */
export async function invalidateAndRevalidate(
  tags: readonly CacheTag[],
): Promise<readonly string[]> {
  const report = await invalidateTags(tags);
  return report.isr;
}

/** `post` / `post:123` → `{ entity, id? }`. Mirrors `@ultimat3/cache`'s wire form. */
function parseWireTag(wire: string): CacheTag {
  const split = wire.indexOf(':');
  if (split === -1) return { entity: wire };
  return { entity: wire.slice(0, split), id: wire.slice(split + 1) };
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

/** Tag-only routes have no clock of their own; a tag bust reaches the CDN through the fanout. */
const TAG_ONLY_S_MAX_AGE_SECONDS = 60;

/**
 * `IsrStore` is a driver seam, so an entry can come back from an app's own store — one backed by
 * Redis round-trips it through JSON, where a `ttlMs` that was never written reads back as
 * `undefined` and `entry.ttlMs === null` is then false. Two failures follow from that one value
 * and neither raises: `now - generatedAt < NaN` is false, so the page is NEVER fresh and every
 * request regenerates it, and the CDN is handed `s-maxage=NaN` — an unparseable directive a
 * conforming cache IGNORES, dropping the page to heuristic caching rather than to the declared
 * age. Read on the request path, so it is TOTAL rather than a throw: a ttl that is not a positive
 * finite number of milliseconds is the tag-only `null` `parseTtlMs` would have answered for it.
 */
function entryTtlMs(entry: IsrEntry): number | null {
  const ttlMs = entry.ttlMs;
  if (ttlMs === null || (Number.isFinite(ttlMs) && ttlMs > 0)) return ttlMs;
  logger.warn('isr.entry_ttl_invalid', { path: entry.path, ttlMs: String(ttlMs) });
  return null;
}

/**
 * The declared TTL is the route's own contract with the CDN: a shared cache must not hold the
 * page longer than the app said it stays true. A flat `s-maxage=60` made `revalidate: { ttl:
 * '5m' }` a lie in one direction and `ttl: '30s'` a lie in the other.
 */
function cacheControl(ttlMs: number | null): string {
  const sMaxAge = ttlMs === null ? TAG_ONLY_S_MAX_AGE_SECONDS : Math.round(ttlMs / 1_000);

  return `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=86400`;
}

/**
 * `entryTtlMs`'s reason, one field over: a store may hand back an entry with no `status`, or one
 * that JSON turned into something else, on the request path. Absent is 200 — the only value any
 * entry carried before the field existed — and anything the range refuses is 200 with a warning,
 * because a stored number must not 500 the page for its whole TTL.
 */
function entryStatus(entry: IsrEntry): number {
  const status = entry.status;
  if (status === undefined) return 200;
  if (isRenderStatus(status)) return status;
  logger.warn('isr.entry_status_invalid', { path: entry.path, status: String(status) });
  return 200;
}

function toResult(
  entry: IsrEntry,
  buildId: string,
  tags: readonly CacheTag[],
  servedStale = false,
): RenderResult {
  const headers: Record<string, string> = {
    ...staticHeaders(entry.hash, buildId),
    'cache-control': cacheControl(entryTtlMs(entry)),
    // The store keys on the locale; a shared cache in front of it has to as well, or the CDN
    // repeats the bug this entry was split to fix. `ssrHeaders`' own line, for the same reason.
    // The rest of the shared key — the cookie, the zone — is added by `@ultimat3/http`'s
    // `cache-headers` stage, which sees the actor this function cannot.
    vary: 'accept-language',
  };
  // The keys an edge purges this document by — `@ultimat3/cache`'s list, never a second one, so
  // what a bust sends and what the page carries cannot drift. Absent, an `invalidates` cleared
  // every tier but the CDN, which held the document for its whole `s-maxage`. The tags were
  // screened when the route registered (`registry.ts`), so this cannot refuse on the request path.
  const keys = surrogateKeys(tags, 'isr');
  if (keys.length > 0) {
    headers['surrogate-key'] = keys.join(' ');
    headers['cache-tag'] = keys.join(',');
  }
  if (servedStale) headers['x-ultimate-isr'] = 'stale';
  return { status: entryStatus(entry), headers, body: entry.html };
}
