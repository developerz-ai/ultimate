// The tier ladder: request-memo -> lru -> redis -> cdn. Reads walk DOWN until a hit, then
// the value is written back UP so the next reader stops earlier. One interface for all four
// so a deployment can omit Redis (single node) or add the CDN tier without touching call
// sites. Order is data, not control flow.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { CacheTtlInvalidError } from './errors';
import type { CacheTag } from './tags';
import { bestEffort } from './tier-failures';

export type TierName = 'request-memo' | 'lru' | 'redis' | 'cdn';

/** Read order. Index in this array is the tier's distance from the request. */
export const TIER_ORDER: readonly TierName[] = ['request-memo', 'lru', 'redis', 'cdn'];

export interface CacheEntry<T> {
  readonly value: T;
  /** Epoch ms; `undefined` means no expiry. */
  readonly expiresAt?: number;
  readonly tags: readonly CacheTag[];
}

export interface CacheSetOptions {
  /**
   * Lifetime in milliseconds. **Positive and finite, always** — omit it for the tier's default.
   * There is no "never expires" and no "do not cache": both used to be spellings of `0` that the
   * LRU and Redis tiers read differently, so every tier now refuses it (`X_CACHE_TTL_INVALID`).
   */
  readonly ttlMs?: number;
  readonly tags?: readonly CacheTag[];
}

/**
 * The one TTL rule, applied by every tier before it writes. Lives here rather than in each tier
 * because two tiers disagreeing about what `0` means is exactly the bug this replaced.
 */
export function assertTtl(key: string, ttlMs: number, tier: TierName): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CacheTtlInvalidError({ key, ttlMs, tier });
  }
  return ttlMs;
}

/** Per-tier result of an invalidation, surfaced verbatim in the `/_x` cache panel. */
export interface TierInvalidation {
  readonly tier: TierName;
  readonly keys: readonly string[];
  readonly skipped?: string;
}

export interface CacheTier {
  readonly name: TierName;
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  del(key: string): Promise<void>;
  invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation>;
}

export interface CacheStack {
  readonly tiers: readonly CacheTier[];
  /** Read-through: walk down, populate up, return the value. */
  read<T>(key: string, load: () => Promise<T>, options?: CacheSetOptions): Promise<T>;
  write<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  drop(key: string): Promise<void>;
}

/**
 * `Clock.now()` is intentionally read through `unknown` — a clock may return a `Date` or
 * epoch ms and every tier needs one comparable number.
 */
export function nowMs(clock: Clock): number {
  const reading: unknown = clock.now();
  if (reading instanceof Date) return reading.getTime();
  return Number(reading);
}

export function isExpired<T>(entry: CacheEntry<T>, at: number): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= at;
}

/** Sorts tiers into `TIER_ORDER` so registration order cannot change read semantics. */
export function sortTiers(tiers: readonly CacheTier[]): readonly CacheTier[] {
  return [...tiers].sort((a, b) => TIER_ORDER.indexOf(a.name) - TIER_ORDER.indexOf(b.name));
}

/**
 * Every tier call here goes through `bestEffort`: a tier that refuses is a tier that did not
 * answer, never a failed business read. `load()` is the one call left unguarded — it *is* the
 * business read, and swallowing it would return `undefined` as if it were the value.
 */
export interface CacheStackOptions {
  /** Read through `nowMs()`; the same clock a tier takes. Defaults to `systemClock`. */
  readonly clock?: Clock;
}

export function createCacheStack(
  tiers: readonly CacheTier[],
  options: CacheStackOptions = {},
): CacheStack {
  const ordered = sortTiers(tiers);
  const clock = options.clock ?? systemClock;

  return {
    tiers: ordered,

    async read<T>(key: string, load: () => Promise<T>, setOptions?: CacheSetOptions): Promise<T> {
      for (let i = 0; i < ordered.length; i += 1) {
        const tier = ordered[i];
        if (tier === undefined) continue;
        const hit = await bestEffort(tier.name, 'get', key, () => tier.get<T>(key));
        if (hit === undefined) continue;
        const now = nowMs(clock);
        // A tier may answer with an entry it has not reaped yet; expiry is decided here, once,
        // by the predicate this module already exported and nothing had ever called.
        if (isExpired(hit, now)) continue;
        // Populate every tier we walked past, closest-first on the next read — carrying the
        // entry's REMAINING life, never the caller's original ttlMs. Re-leasing a value one
        // second from expiry for a fresh five minutes on every read is a hot key that never
        // goes stale enough to be refetched.
        const promoted: CacheSetOptions = {
          ...setOptions,
          tags: hit.tags,
          ...(hit.expiresAt === undefined ? {} : { ttlMs: hit.expiresAt - now }),
        };
        for (let up = 0; up < i; up += 1) {
          const closer = ordered[up];
          if (closer === undefined) continue;
          await bestEffort(closer.name, 'set', key, () => closer.set(key, hit.value, promoted));
        }
        return hit.value;
      }

      const value = await load();
      for (const tier of ordered) {
        await bestEffort(tier.name, 'set', key, () => tier.set(key, value, setOptions));
      }
      return value;
    },

    async write<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
      for (const tier of ordered) {
        await bestEffort(tier.name, 'set', key, () => tier.set(key, value, options));
      }
    },

    async drop(key: string): Promise<void> {
      for (const tier of ordered) {
        await bestEffort(tier.name, 'del', key, () => tier.del(key));
      }
    },
  };
}
