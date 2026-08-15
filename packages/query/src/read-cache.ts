/**
 * The read tier: the `ReadCache` seam a `cache:` query reads through, the bounded in-memory
 * default behind it, and the one invalidation hop. Split from `cache.ts` because the tier and
 * the request memo answer different questions — the memo asks "did THIS request already read
 * this?", the tier asks "did anyone, and is that answer still true?".
 */

import type { CacheTag, LruOptions } from '@ultimat3/cache';
import { CacheTooLargeError, invalidateTags, LruCache } from '@ultimat3/cache';

export interface ReadCacheEntry {
  readonly value: unknown;
  readonly expiresAt: number | null;
  /**
   * What the entry is dropped by. Optional so an existing `ReadCache` implementation still
   * compiles — but an entry written without them can only ever expire, never be invalidated.
   */
  readonly tags?: readonly CacheTag[];
}

export interface ReadCache {
  get(key: string): Promise<ReadCacheEntry | undefined>;
  set(key: string, entry: ReadCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Drop every entry carrying one of `tags`. Optional because it arrived after the interface
   * shipped; a tier that omits it keeps entries until they expire, which is why the default
   * below implements it.
   */
  invalidateTags?(tags: readonly CacheTag[]): Promise<readonly string[]>;
}

/**
 * A `cache:` block with no `ttlMs`. Tag invalidation is the primary eviction, so this is the
 * backstop for the read whose tags never fire — one number, the same 60s `@ultimat3/cache`'s
 * LRU tier defaults to.
 */
export const DEFAULT_READ_CACHE_TTL_MS = 60_000;

/** 32 MiB: half the LRU tier's budget, because a read cache is not the whole cache. */
export const DEFAULT_READ_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * In-memory default. Production installs the tiered cache from @ultimat3/cache.
 *
 * Backed by that package's `LruCache` rather than a bare `Map`: the bound and the tag→keys
 * index are the two things a read cache cannot go without, and re-deriving "which keys does
 * this tag bust" here would be a second definition of tag matching.
 */
export class MemoryReadCache implements ReadCache {
  readonly #entries: LruCache;

  constructor(options: LruOptions = {}) {
    this.#entries = new LruCache({ maxBytes: DEFAULT_READ_CACHE_MAX_BYTES, ...options });
  }

  async get(key: string): Promise<ReadCacheEntry | undefined> {
    return this.#entries.get<ReadCacheEntry>(key)?.value;
  }

  async set(key: string, entry: ReadCacheEntry): Promise<void> {
    const now = Date.now();
    // Already stale on arrival: storing it would hand the next reader an entry `get` has to
    // throw away, and `ttl <= 0` is how the LRU spells "no expiry" — the opposite answer.
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.#entries.del(key);
      return;
    }
    // The entry is stored whole so `get` returns the absolute expiry it was given back,
    // unrounded by the tier's own clock.
    try {
      this.#entries.set(key, entry, {
        // A `null` expiry is "the caller named none", never "never": @ultimat3/cache's tiers
        // refuse a non-positive `ttlMs` and have no immortal entry to offer, so it falls to the
        // tier's own default — which is the backstop an unbounded read cache was missing.
        ...(entry.expiresAt === null ? {} : { ttlMs: entry.expiresAt - now }),
        tags: entry.tags ?? [],
      });
    } catch (error) {
      // A row set too large to cache is a miss on the next read, never a failed read.
      if (!(error instanceof CacheTooLargeError)) throw error;
    }
  }

  async delete(key: string): Promise<void> {
    this.#entries.del(key);
  }

  async invalidateTags(tags: readonly CacheTag[]): Promise<readonly string[]> {
    return this.#entries.invalidateTags(tags);
  }
}

let tier: ReadCache = new MemoryReadCache();

export function setReadCache(cache: ReadCache): void {
  tier = cache;
}

export function getReadCache(): ReadCache {
  return tier;
}

/**
 * The one invalidation path. Actions call the same function via their `cache`.
 *
 * Two drops, one call: the graph @ultimat3/cache owns reaches every registered tier, ISR route,
 * CDN path and live query, and the read tier is dropped by the same tags in the same hop. The
 * read tier is not a registered `CacheTier` — it is this package's seam, replaceable per
 * deployment through `setReadCache` — so the fan-out cannot reach it and this must.
 */
export async function invalidateQueryTags(tags: readonly CacheTag[]): Promise<void> {
  await invalidateTags(tags);
  await tier.invalidateTags?.(tags);
}
