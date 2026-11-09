/**
 * The ISR store: what an entry is, the driver seam an app may back with its own storage, and the
 * bounded in-memory default. Split from `render-isr.ts`, which is the controller that reads it.
 */

import { finiteCount } from '@ultimat3/core';

export type IsrState = 'miss' | 'hit' | 'stale';

/**
 * What a store method answers: the value, or a promise of it. A store over a disk, a bucket or a
 * database cannot answer synchronously, and one shared store is what makes three replicas one
 * ISR cache instead of three (`storageIsrStore`). The controller awaits every call.
 */
export type IsrAnswer<T> = T | Promise<T>;

export interface IsrEntry {
  /**
   * The store key: the request's pathname AND its query, params sorted. Not the route's pattern
   * and not the bare pathname — `/blog?page=2` and `/blog?page=3` render different documents, and
   * keying both as `/blog` served the second visitor the first one's HTML (#171).
   * A routed locale prefix stays on it (`/en/blog`): the controller removes it only to find the
   * route, so a store may never use this as a route path.
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

/**
 * A fence the STORE holds, for a store more than one process writes. A process's own fence
 * (`@ultimat3/cache`'s) only knows the busts that process heard: a replica that began a render
 * before a purge, and has not yet been told of it, would write the purged page straight back —
 * and with the bus down it stayed for the page's whole `ttl`. So the purge moves a generation in
 * the store itself, and a write that read an older one is refused there.
 *
 * Keyed by tag ENTITY (`post` for `post` and `post:1` alike), which is coarser than a tag and
 * errs the safe way: an unrelated row's bust refuses a write, and the next request renders again.
 * A custom store implements all three over its own backend; `setIfCurrent` must be ATOMIC there
 * (a transaction, a Lua script, a conditional put) — a read-then-write is the race over again.
 */
export interface IsrTagFence {
  /** An opaque reading of these entities' generations, taken before a render reads its rows. */
  sample(entities: readonly string[]): IsrAnswer<string>;
  /** A bust of these entities happened: every reading taken before this call is void. */
  bump(entities: readonly string[]): IsrAnswer<void>;
  /** `set(entry)` only while `sampled` is still the reading. `false`: refused, nothing written. */
  setIfCurrent(entry: IsrEntry, entities: readonly string[], sampled: string): IsrAnswer<boolean>;
}

export interface IsrStore {
  /**
   * Present on a store that is safe to SHARE between processes under `onInvalidate: 'purge'`.
   * `memoryIsrStore` has it. A store handed to the boot without one is refused there when any
   * route purges (`X_ROUTE_MODE_INVALID`), rather than left to re-fill a purged page in silence.
   */
  readonly tagFence?: IsrTagFence;
  get(path: string): IsrAnswer<IsrEntry | undefined>;
  set(entry: IsrEntry): IsrAnswer<void>;
  /**
   * Mark a held page stale IN PLACE — `false` when the store does not hold it. Its own method and
   * not `set({ ...entry, stale: true })`, because `set` means "this page was just generated" and a
   * store is entitled to order its eviction by that: the read-modify-write made the STALEST page
   * the newest, so a tag bust protected exactly the pages that most needed regenerating.
   */
  markStale(path: string): IsrAnswer<boolean>;
  delete(path: string): IsrAnswer<void>;
  paths(): IsrAnswer<readonly string[]>;
}

/** `memoryIsrStore`'s own shape: every answer synchronous, so a test reads it without `await`. */
export interface MemoryIsrStore extends IsrStore {
  readonly tagFence: {
    sample(entities: readonly string[]): string;
    bump(entities: readonly string[]): void;
    setIfCurrent(entry: IsrEntry, entities: readonly string[], sampled: string): boolean;
  };
  get(path: string): IsrEntry | undefined;
  set(entry: IsrEntry): void;
  markStale(path: string): boolean;
  delete(path: string): void;
  paths(): readonly string[];
}

/**
 * How many rendered pages the default store holds. A route table supports `:params` and `*`, so
 * `/blog/:slug` has as many ISR paths as the blog has slugs — 404-shaped ones that still render
 * included. Unbounded, a crawler over 100k slugs is 100k HTML strings resident for the life of
 * the process.
 */
export const DEFAULT_ISR_MAX_ENTRIES = 1_000;

/**
 * How much html the default store holds, counted as `html.length` — one byte per code unit, which
 * is what JSC stores a Latin-1 page in (twice that for a page with any other character). The count
 * cap alone bounds nothing in bytes: 1,000 entries of a 7 MiB page is 7 GiB resident.
 */
export const DEFAULT_ISR_MAX_BYTES = 256 * 1024 * 1024;

export interface MemoryIsrStoreOptions {
  /** Pages retained. The least recently used goes first. */
  readonly maxEntries?: number;
  /** Total `html.length` retained. A page larger than this alone is not kept at all. */
  readonly maxBytes?: number;
}

export function memoryIsrStore(options: MemoryIsrStoreOptions = {}): MemoryIsrStore {
  // `map.size > NaN` is false for every size, so a cap that arrived non-finite is not a bigger
  // cap — it is no cap, and this store is the one thing bounding a crawler over 100k slugs.
  const maxEntries = finiteCount(
    'memoryIsrStore',
    'maxEntries',
    options.maxEntries ?? DEFAULT_ISR_MAX_ENTRIES,
  );
  const maxBytes = finiteCount(
    'memoryIsrStore',
    'maxBytes',
    options.maxBytes ?? DEFAULT_ISR_MAX_BYTES,
  );
  // The Map's iteration order IS recency: a `set` and a hit `get` re-insert, so the first key is
  // the least recently used page.
  const map = new Map<string, IsrEntry>();
  let bytes = 0;
  // One counter per tag entity ever busted — bounded by the entities an app declares.
  const generations = new Map<string, number>();
  const reading = (entities: readonly string[]): string =>
    entities.map((entity) => String(generations.get(entity) ?? 0)).join(',');
  const remove = (path: string): void => {
    const held = map.get(path);
    if (held === undefined) return;
    bytes -= held.html.length;
    map.delete(path);
  };
  const set = (entry: IsrEntry): void => {
    remove(entry.path);
    // Kept, it would evict every other page and then itself be the only one over the cap.
    if (entry.html.length > maxBytes) return;
    map.set(entry.path, entry);
    bytes += entry.html.length;
    while (map.size > maxEntries || bytes > maxBytes) {
      const oldest = map.keys().next();
      if (oldest.done === true) break;
      remove(oldest.value);
    }
  };
  return {
    tagFence: {
      sample: reading,
      bump: (entities) => {
        for (const entity of entities) generations.set(entity, (generations.get(entity) ?? 0) + 1);
      },
      // One synchronous step in one process, so the compare and the write cannot be interleaved.
      setIfCurrent: (entry, entities, sampled) => {
        if (reading(entities) !== sampled) return false;
        set(entry);
        return true;
      },
    },
    get: (path) => {
      const entry = map.get(path);
      if (entry === undefined) return undefined;
      map.delete(path);
      map.set(path, entry);
      return entry;
    },
    set,
    // In place: `map.set` on a key the Map already holds keeps its position, and that position is
    // the eviction order. Never `delete` + `set` here — a bust would make the stalest page the
    // most recently used. Same html, so the byte count does not move.
    markStale: (path) => {
      const entry = map.get(path);
      if (entry === undefined) return false;
      map.set(path, { ...entry, stale: true });
      return true;
    },
    delete: remove,
    paths: () => [...map.keys()].sort(),
  };
}
