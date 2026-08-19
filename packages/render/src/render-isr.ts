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
  registerDependent,
  registerRevalidator,
  unregisterDependent,
} from '@ultimat3/cache';
import { logger, renderThrowable } from '@ultimat3/core';
import { parseTtlMs } from './duration';
import type { RouteDescriptor } from './registry';
import { describeRoutes } from './registry';
import { contentHash, staticHeaders } from './render-static';
import type { RenderResult } from './route';

export type IsrState = 'miss' | 'hit' | 'stale';

export interface IsrEntry {
  readonly path: string;
  readonly html: string;
  readonly hash: string;
  readonly generatedAt: number;
  readonly ttlMs: number | null;
  /** Set by a tag invalidation; independent of the TTL clock. */
  readonly stale: boolean;
}

export interface IsrStore {
  get(path: string): IsrEntry | undefined;
  set(entry: IsrEntry): void;
  delete(path: string): void;
  paths(): readonly string[];
}

/**
 * How many rendered pages the default store holds. A route table supports `:params` and `*`, so
 `/blog/:slug` has as many ISR paths as the blog has slugs — 404-shaped ones that still render
 * included. Unbounded, a crawler over 100k slugs is 100k HTML strings resident for the life of
 * the process.
 */
export const DEFAULT_ISR_MAX_ENTRIES = 1_000;

export interface MemoryIsrStoreOptions {
  /** Pages retained. The least recently generated goes first. */
  readonly maxEntries?: number;
}

export function memoryIsrStore(options: MemoryIsrStoreOptions = {}): IsrStore {
  const maxEntries = options.maxEntries ?? DEFAULT_ISR_MAX_ENTRIES;
  const map = new Map<string, IsrEntry>();
  return {
    get: (path) => map.get(path),
    set: (entry) => {
      // Re-inserted rather than overwritten, so the Map's iteration order IS generation order and
      // the first key is the least recently generated page.
      map.delete(entry.path);
      map.set(entry.path, entry);
      while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done === true) break;
        map.delete(oldest.value);
      }
    },
    delete: (path) => {
      map.delete(path);
    },
    paths: () => [...map.keys()].sort(),
  };
}

export type IsrRenderFn = (path: string) => string | Promise<string>;

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
}

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

export function createIsrController(options: IsrControllerOptions = {}): IsrController {
  const store = options.store ?? memoryIsrStore();
  const now = options.now ?? (() => Date.now());
  const routes = options.routes ?? describeRoutes;
  const isrDependents =
    options.isrDependents ?? ((tags: readonly CacheTag[]) => dependentsOfKind(tags, 'isr-route'));
  const buildId = options.buildId ?? 'dev';
  const pending = new Map<string, Promise<IsrEntry>>();
  const registered = new Set<string>();

  function descriptorFor(path: string): RouteDescriptor | undefined {
    const table = routes();
    return table.find((r) => r.path === path) ?? table.find((r) => matchesRoute(path, r.path));
  }

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
    if (entry.ttlMs === null) return true; // tag-only revalidation: fresh until invalidated
    return now() - entry.generatedAt < entry.ttlMs;
  }

  function regenerate(path: string, render: IsrRenderFn): Promise<IsrEntry> {
    const existing = pending.get(path);
    if (existing !== undefined) return existing;

    const descriptor = descriptorFor(path);
    const work = (async (): Promise<IsrEntry> => {
      const html = await render(path);
      const entry: IsrEntry = {
        path,
        html,
        hash: contentHash(html),
        generatedAt: now(),
        ttlMs: parseTtlMs(descriptor?.revalidateTtl),
        stale: false,
      };
      store.set(entry);
      registerPath(path, descriptor);
      forgetEvictedPaths();
      return entry;
    })();

    pending.set(path, work);
    void work.catch(() => undefined).finally(() => pending.delete(path));
    return work;
  }

  function markStale(path: string): boolean {
    const entry = store.get(path);
    if (entry === undefined) return false;
    store.set({ ...entry, stale: true });
    return true;
  }

  return {
    store: () => store,
    inflight: () => pending.size,
    regenerate,
    markStale,

    async serve(path, render) {
      const cached = store.get(path);

      if (cached === undefined) {
        const entry = await regenerate(path, render);
        return { state: 'miss', entry, result: toResult(entry, buildId), regenerating: false };
      }

      if (isFresh(cached)) {
        return {
          state: 'hit',
          entry: cached,
          result: toResult(cached, buildId),
          regenerating: false,
        };
      }

      // stale-while-revalidate: answer from the stale copy now, refresh behind the request.
      const already = pending.has(path);
      void regenerate(path, render).catch((error: unknown) => {
        // `renderThrowable`, never `.message`/`String()`: this `.catch` is the last frame under a
        // route's own render function, and `String()` raises on a null-prototype object — the
        // handler that exists to REPORT the failure became a second, unhandled rejection.
        logger.warn('isr.regenerate.failed', { path, error: renderThrowable(error) });
      });
      return {
        state: 'stale',
        entry: cached,
        result: toResult(cached, buildId, true),
        regenerating: !already,
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

/** A stored path belongs to a route when the route's pattern matches it. */
function matchesRoute(storedPath: string, routePath: string): boolean {
  if (!routePath.includes(':') && !routePath.includes('*')) return storedPath === routePath;
  const parts = routePath.split('/').map(segmentPattern);
  return new RegExp(`^${parts.join('/')}/?$`).test(storedPath);
}

function segmentPattern(segment: string): string {
  if (segment.startsWith(':')) return '([^/]+)';
  if (segment.startsWith('*')) return '(.*)';
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tag-only routes have no clock of their own; a tag bust reaches the CDN through the fanout. */
const TAG_ONLY_S_MAX_AGE_SECONDS = 60;

/**
 * The declared TTL is the route's own contract with the CDN: a shared cache must not hold the
 * page longer than the app said it stays true. A flat `s-maxage=60` made `revalidate: { ttl:
 * '5m' }` a lie in one direction and `ttl: '30s'` a lie in the other.
 */
function cacheControl(ttlMs: number | null): string {
  const sMaxAge = ttlMs === null ? TAG_ONLY_S_MAX_AGE_SECONDS : Math.round(ttlMs / 1_000);
  return `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=86400`;
}

function toResult(entry: IsrEntry, buildId: string, servedStale = false): RenderResult {
  const headers: Record<string, string> = {
    ...staticHeaders(entry.hash, buildId),
    'cache-control': cacheControl(entry.ttlMs),
  };
  if (servedStale) headers['x-ultimate-isr'] = 'stale';
  return { status: 200, headers, body: entry.html };
}
