/**
 * Read caching, two layers: a per-request memo (same query twice in one render
 * costs one round trip) and a tag-keyed tier behind the `ReadCache` interface.
 * Invalidation is never local — it goes through @ultimat3/cache so an action's
 * `invalidates` and a query's `tags` meet in one graph.
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

/** Request-scoped memo. Keyed by ctx identity so it dies with the request. */
const memos = new WeakMap<object, Map<string, unknown>>();

export function requestMemo(ctx: Ctx): Map<string, unknown> {
  const key: object = ctx;
  const existing = memos.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, unknown>();
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
  const memoized = memo.get(key);
  if (memoized !== undefined) return memoized as T;

  const cached = await tier.get(key);
  if (cached !== undefined) {
    memo.set(key, cached.value);
    return cached.value as T;
  }

  const value = await run();
  memo.set(key, value);
  await tier.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
  return value;
}

/** The one invalidation path. Actions call the same function via their `cache`. */
export async function invalidateQueryTags(tags: readonly CacheTag[]): Promise<void> {
  await invalidateTags(tags);
}
