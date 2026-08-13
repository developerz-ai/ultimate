/**
 * Read caching, two layers: a per-request memo (`readOnce` — same query twice in one render
 * costs one execution, whether the second read follows the first or races it) and, for a query
 * that declares `cache:`, a tag-keyed tier behind the `ReadCache` interface (`readThrough`).
 * Every read gets the memo; the tier is the half a query opts into. Invalidation is never
 * local — it goes through @ultimat3/cache so an action's `invalidates` and a query's `tags`
 * meet in one graph.
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

/**
 * One execution per key per request: the first caller runs it, every caller after joins it.
 *
 * This is the layer a query gets whether or not it declares `cache:` — an uncached read asked
 * once per row of a list is the N+1 the memo exists to collapse.
 */
export async function readOnce<T>(ctx: Ctx, key: string, run: () => Promise<T>): Promise<T> {
  const memo = requestMemo(ctx);
  const joined = memo.get(key);
  // Already answered or already being answered: the second reader waits on the first read
  // rather than starting a competing one. Awaiting a settled promise costs a microtask.
  if (joined !== undefined) return (await joined) as T;
  return publish(memo, key, run);
}

/**
 * Runs no matter what the memo holds, and then *becomes* what it holds — what `fresh: true` asks
 * for.
 *
 * Joining is the half `fresh` refuses; publishing is not. A fresh read that left the earlier entry
 * in place would read past a write for its own caller and hand the next plain read of that key in
 * the same request the answer this one just proved stale — so the guarantee would end at the one
 * call that asked for it.
 */
export function readFresh<T>(ctx: Ctx, key: string, run: () => Promise<T>): Promise<T> {
  return publish(requestMemo(ctx), key, run);
}

/** The read in flight: published before its first await, evicted if it rejects. */
async function publish<T>(
  memo: Map<string, Promise<unknown>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  // Published before the first await, so a reader arriving in the same tick finds this read.
  const flight = run();
  memo.set(key, flight);
  try {
    return await flight;
  } catch (error) {
    // A rejection is not an answer. Drop it so a later read in the same request retries
    // instead of replaying one failure until the request ends. Only ours: a fresh read may have
    // replaced this entry already, and evicting that one would discard a live answer.
    if (memo.get(key) === flight) memo.delete(key);
    throw error;
  }
}

/** Memo first, then the tier, then the source — what a query with `cache:` reads through. */
export function readThrough<T>(
  ctx: Ctx,
  key: string,
  ttlMs: number | null,
  run: () => Promise<T>,
): Promise<T> {
  return readOnce(ctx, key, () => fill(key, ttlMs, run));
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
