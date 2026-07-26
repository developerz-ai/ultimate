// The tier ladder: request-memo -> lru -> redis -> cdn. Reads walk DOWN until a hit, then
// the value is written back UP so the next reader stops earlier. One interface for all four
// so a deployment can omit Redis (single node) or add the CDN tier without touching call
// sites. Order is data, not control flow.

import type { Clock } from '@ultimat3/core';
import type { CacheTag } from './tags';

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
  readonly ttlMs?: number;
  readonly tags?: readonly CacheTag[];
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

export function createCacheStack(tiers: readonly CacheTier[]): CacheStack {
  const ordered = sortTiers(tiers);

  return {
    tiers: ordered,

    async read<T>(key: string, load: () => Promise<T>, options?: CacheSetOptions): Promise<T> {
      for (let i = 0; i < ordered.length; i += 1) {
        const tier = ordered[i];
        if (tier === undefined) continue;
        const hit = await tier.get<T>(key);
        if (hit === undefined) continue;
        // Populate every tier we walked past, closest-first on the next read.
        for (let up = 0; up < i; up += 1) {
          await ordered[up]?.set(key, hit.value, { ...options, tags: hit.tags });
        }
        return hit.value;
      }

      const value = await load();
      for (const tier of ordered) await tier.set(key, value, options);
      return value;
    },

    async write<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
      for (const tier of ordered) await tier.set(key, value, options);
    },

    async drop(key: string): Promise<void> {
      for (const tier of ordered) await tier.del(key);
    },
  };
}
