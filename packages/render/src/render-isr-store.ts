/**
 * The ISR store: what an entry is, the driver seam an app may back with its own storage, and the
 * bounded in-memory default. Split from `render-isr.ts`, which is the controller that reads it.
 */

import { finiteCount } from '@ultimat3/core';

export type IsrState = 'miss' | 'hit' | 'stale';

export interface IsrEntry {
  /**
   * The store key: the request's pathname AND its query, params sorted. Not the route's pattern
   * and not the bare pathname — `/blog?page=2` and `/blog?page=3` render different documents, and
   * keying both as `/blog` served the second visitor the first one's HTML (#171).
   */
  readonly path: string;
  readonly html: string;
  readonly hash: string;
  readonly generatedAt: number;
  readonly ttlMs: number | null;
  /** Set by a tag invalidation; independent of the TTL clock. */
  readonly stale: boolean;
  /**
   * What the page answers, 200–599. Optional because an entry can come back from an app's own
   * store, written before this field existed or JSON-round-tripped without it; absent reads as
   * 200, the only status an entry ever had until `withStatus`.
   */
  readonly status?: number;
}

export interface IsrStore {
  get(path: string): IsrEntry | undefined;
  set(entry: IsrEntry): void;
  /**
   * Mark a held page stale IN PLACE — `false` when the store does not hold it. Its own method and
   * not `set({ ...entry, stale: true })`, because `set` means "this page was just generated" and a
   * store is entitled to order its eviction by that: the read-modify-write made the STALEST page
   * the newest, so a tag bust protected exactly the pages that most needed regenerating.
   */
  markStale(path: string): boolean;
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
  // `map.size > NaN` is false for every size, so a cap that arrived non-finite is not a bigger
  // cap — it is no cap, and this store is the one thing bounding a crawler over 100k slugs.
  const maxEntries = finiteCount(
    'memoryIsrStore',
    'maxEntries',
    options.maxEntries ?? DEFAULT_ISR_MAX_ENTRIES,
  );
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
    // In place: `map.set` on a key the Map already holds keeps its position, and that position is
    // the eviction order. Never `delete` + `set` here — that is the bug this method exists to fix.
    markStale: (path) => {
      const entry = map.get(path);
      if (entry === undefined) return false;
      map.set(path, { ...entry, stale: true });
      return true;
    },
    delete: (path) => {
      map.delete(path);
    },
    paths: () => [...map.keys()].sort(),
  };
}
