/**
 * Read caching, two layers: a per-request memo (same query twice in one render
 * costs one round trip, whether the second read follows the first or races it)
 * and a tag-keyed tier behind the `ReadCache` interface. Invalidation is never
 * local — it goes through @ultimat3/cache so an action's `invalidates` and a
 * query's `tags` meet in one graph.
 */

import type { CacheTag } from '@ultimat3/cache';
import { invalidateTags } from '@ultimat3/cache';
import type { Ctx } from '@ultimat3/core';
import { fingerprint } from './stable';
import { tagKeys } from './tags';

export interface ReadCacheEntry {
  readonly value: unknown;
  readonly expiresAt: number | null;
}

export interface ReadCache {
  get(key: string): Promise<ReadCacheEntry | undefined>;
  set(key: string, entry: ReadCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory default. Production installs the tiered cache from @ultimat3/cache. */
export class MemoryReadCache implements ReadCache {
  readonly #entries = new Map<string, ReadCacheEntry>();

  async get(key: string): Promise<ReadCacheEntry | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, entry: ReadCacheEntry): Promise<void> {
    this.#entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
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
 * Request-scoped memo. Keyed by ctx identity so it dies with the request.
 *
 * An entry is the read *in flight*, not its value: unsettled it is the answer a caller is
 * already waiting for, settled it is the answer. That is what makes two concurrent identical
 * reads one round trip — and it is why no sentinel is needed for a legitimately `undefined`
 * value, which a value-keyed memo cannot tell apart from a miss. A promise is never `undefined`.
 */
const memos = new WeakMap<object, Map<string, Promise<unknown>>>();

export function requestMemo(ctx: Ctx): Map<string, Promise<unknown>> {
  const key: object = ctx;
  const existing = memos.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, Promise<unknown>>();
  memos.set(key, created);
  return created;
}

/** Deterministic: same query + same input + same tags => same key. */
export function cacheKeyFor(name: string, input: unknown, tags: readonly CacheTag[]): string {
  return `query:${name}:${fingerprint(input)}:${tagKeys(tags).join(',')}`;
}

/** Memo first, then the tier, then the source. */
export async function readThrough<T>(
  ctx: Ctx,
  key: string,
  ttlMs: number | null,
  run: () => Promise<T>,
): Promise<T> {
  const memo = requestMemo(ctx);
  const joined = memo.get(key);
  // Already answered or already being answered: the second reader waits on the first read
  // rather than starting a competing one. Awaiting a settled promise costs a microtask.
  if (joined !== undefined) return (await joined) as T;

  // Published before the first await, so a reader arriving in the same tick finds this read.
  const flight = fill(key, ttlMs, run);
  memo.set(key, flight);
  try {
    return (await flight) as T;
  } catch (error) {
    // A rejection is not an answer. Drop it so a later read in the same request retries
    // instead of replaying one failure until the request ends.
    if (memo.get(key) === flight) memo.delete(key);
    throw error;
  }
}

/** The read itself — tier, then the source. Runs once per key per request; the rest join it. */
async function fill<T>(key: string, ttlMs: number | null, run: () => Promise<T>): Promise<T> {
  const cached = await tier.get(key);
  if (cached !== undefined) return cached.value as T;

  const value = await run();
  await tier.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
  return value;
}

/** The one invalidation path. Actions call the same function via their `cache`. */
export async function invalidateQueryTags(tags: readonly CacheTag[]): Promise<void> {
  await invalidateTags(tags);
}
