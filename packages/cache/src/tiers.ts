// The tier ladder: request-memo -> lru -> redis -> cdn. Reads walk DOWN until a hit, then
// the value is written back UP so the next reader stops earlier. One interface for all four
// so a deployment can omit Redis (single node) or add the CDN tier without touching call
// sites. Order is data, not control flow.

import type { CacheTierName, Clock, Scheduler } from '@ultimat3/core';
import { CACHE_TIERS, systemClock } from '@ultimat3/core';
import { CacheJitterInvalidError, CacheTtlInvalidError } from './errors';
import type { CacheFence } from './fence';
import { markInvalidated, sampleFence } from './fence';
import { mergeSetOptions, tagsAddedSince, ttlOptionsFor } from './set-options';
import { createSingleFlight } from './single-flight';
import type { CacheTag } from './tags';
import { bestEffort } from './tier-failures';

/**
 * The rungs, spelled in `@ultimat3/core` and nowhere else. Tier 0 owns the NAMES because
 * `app.config.ts` names them too and core is the one place a tier-0 declaration and this package
 * can both see; the ladder — order, promotion, fan-out — is still this file's. Aliased rather than
 * re-exported under core's name so the ~30 call sites that already import `TierName` keep working:
 * one declaration, two names, against one declaration each in two packages that disagreed.
 */
export type TierName = CacheTierName;

/** Read order. Index in this array is the tier's distance from the request. */
export const TIER_ORDER: readonly TierName[] = CACHE_TIERS;

/**
 * Who a swallowed refusal is attributed to in `recentTierFailures()` and the `/_x` panel: every
 * rung of the ladder, plus a store that degrades the same way without being on it.
 *
 * Closed rather than a free-form string, and NOT a widening of `TierName`: `TIER_ORDER` is the
 * ladder and a name missing from it sorts to `-1`, ahead of the request memo. A label is a log
 * facet; a `TierName` is a position. Two spellings of one store is a panel nobody can group.
 *
 * **`'query-read'` emits nothing as of 2026-08** and is kept only because narrowing a shipped
 * exported union breaks any caller that passes it to `bestEffort`. It named `@ultimat3/query`'s
 * private read cache, which was a store in no registry — so `invalidateTags` could not reach it,
 * which is exactly why that store is gone and a `cache:` read now fills these tiers. A refusal on
 * that path is attributed to the tier that actually refused. Do not add a second such member: a
 * cache worth a label is a cache worth registering.
 */
export type TierLabel = TierName | 'query-read';

/** Injected so a jittered TTL is deterministic in a test. Never `Math.random()` at a call site. */
export type Rng = () => number;

/**
 * 5%: enough to smear a warm-up herd across the tail of its lease, small enough that a 60s cache
 * is never mistaken for a 54s one. Higher is a correctness question for the app, not the tier.
 */
export const DEFAULT_TTL_JITTER_FRACTION = 0.05;

/** How a tier spreads its TTLs. Every tier takes it; `assertTtl` is the one place it is applied. */
export interface TtlJitter {
  /** Fraction of the lease that may be shaved off, in `[0, 1)`. `0` disables it. */
  readonly jitterFraction?: number;
  /** `() => 0` is "the full lease, this write" — the deterministic setting a test wants. */
  readonly rng?: Rng;
}

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
  /**
   * Lifetime for a `null`/`undefined` load, when it should differ from `ttlMs`. A lookup for a
   * row that has not replicated yet answers `null` 40ms before it lands; holding that for the
   * positive TTL serves "does not exist" for five minutes. Omitted means "same as `ttlMs`",
   * which is the accident this field makes a decision.
   */
  readonly negativeTtlMs?: number;
  readonly tags?: readonly CacheTag[];
}

/**
 * The one TTL rule, applied by every tier before it writes: validate, then spread. It lives here
 * rather than in each tier because two tiers disagreeing about what `0` means is exactly the bug
 * this replaced — and jitter belongs at the same choke point for the same reason.
 *
 * Jitter is not a nicety. A rolling restart warms 40,000 keys inside 30 seconds and hands every
 * one of them the same 300s lease; five minutes later all 40,000 expire inside the same 30-second
 * window, and with single-flight sharing only the loads that overlap that is still 40,000 origin
 * reads. Shaving a random slice off each lease is what turns one cliff into a ramp.
 */
/**
 * Where a lease is being spent. Every tier — plus `'semantic'`, which is not a tier and still may
 * not invent its own reading of `ttlMs: 0`.
 */
export type TtlScope = TierName | 'semantic';

export function assertTtl(
  key: string,
  ttlMs: number,
  tier: TtlScope,
  jitter: TtlJitter = {},
): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CacheTtlInvalidError({ key, ttlMs, tier });
  }
  const fraction = jitter.jitterFraction ?? DEFAULT_TTL_JITTER_FRACTION;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new CacheJitterInvalidError({ tier, jitterFraction: fraction });
  }
  if (fraction === 0) return ttlMs;
  // Clamped rather than trusted: an `rng` outside [0, 1) would EXTEND the lease past what the
  // caller asked for, which is a stale read no reader can explain.
  const roll = Math.min(1, Math.max(0, (jitter.rng ?? Math.random)()));
  return Math.max(1, Math.round(ttlMs * (1 - fraction * roll)));
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
 * A `load()` still running at 30s has no reader left to serve: `stack.read` is on the request path,
 * and `@ultimat3/http` abandons the request that is waiting for it at the same 30s
 * (`requestTimeoutMs`). Stated as a literal because cache is tier 1 and http is tier 2, so the
 * number cannot be imported — deliberately NOT a JWKS fetch's bound, which is a transport's.
 */
export const DEFAULT_LOAD_DEADLINE_MS = 30_000;

/**
 * Every tier call here goes through `bestEffort`: a tier that refuses is a tier that did not
 * answer, never a failed business read. `load()` is the one call left unguarded — it *is* the
 * business read, and swallowing it would return `undefined` as if it were the value.
 */
export interface CacheStackOptions {
  /** Read through `nowMs()`; the same clock a tier takes. Defaults to `systemClock`. */
  readonly clock?: Clock;
  /**
   * How long one `load()` may hold its key before a later reader is allowed to start its own,
   * instead of joining a promise that may never resolve. Defaults to `DEFAULT_LOAD_DEADLINE_MS`.
   *
   * An option on the stack rather than an `app.config.ts` key on purpose: the ceiling belongs to
   * whoever wrote the `load()`, not to the deployment, and a leaf key nothing reads is what
   * `bun run scripts/config-readers.ts` exists to refuse.
   */
  readonly loadDeadlineMs?: number;
  /** Injected so the deadline is provable without a test waiting one out. */
  readonly schedule?: Scheduler;
}

export function createCacheStack(
  tiers: readonly CacheTier[],
  options: CacheStackOptions = {},
): CacheStack {
  const ordered = sortTiers(tiers);
  const clock = options.clock ?? systemClock;
  // Per stack, not per module: two stacks are two ladders and must not join each other's loads.
  //
  // The deadline frees the KEY and nothing else — `load()` is the app's function and this stack
  // holds no signal that could abort it, so the wedged load runs on and the readers already
  // holding its promise still get whatever it eventually answers. What eviction buys is that the
  // NEXT reader is allowed to try. So the worst case is one duplicate fill, which the ladder's
  // last-write-wins `set` already tolerates, against a key pinned for the life of the process.
  const flight = createSingleFlight({
    deadlineMs: options.loadDeadlineMs ?? DEFAULT_LOAD_DEADLINE_MS,
    schedule: options.schedule,
  });

  /** Take back what a fence refused mid-ladder: half a stale ladder is still a stale read. */
  const rollback = async (written: readonly CacheTier[], key: string): Promise<void> => {
    for (const tier of [...written].reverse()) {
      await bestEffort(tier.name, 'del', key, () => tier.del(key));
    }
  };

  /**
   * `fence` is what stops a fill from republishing what an invalidation just cleared: the value
   * was read by a `load()` that started before the bust, so writing it now hides that write from
   * every reader for the whole TTL — and the invalidation reported `errors: []` while doing it.
   * Re-checked per tier rather than once, because the ladder is several awaits long.
   */
  const fill = async <T>(
    key: string,
    value: T,
    setOptions?: CacheSetOptions,
    fence?: CacheFence,
  ): Promise<void> => {
    const resolved = ttlOptionsFor(value, setOptions);
    const written: CacheTier[] = [];
    for (const tier of ordered) {
      if (fence !== undefined && !fence.isValid()) {
        await rollback(written, key);
        return;
      }
      await bestEffort(tier.name, 'set', key, () => tier.set(key, value, resolved));
      written.push(tier);
    }
  };

  /** Walks down, promoting into every tier it passed. `undefined` means every tier missed. */
  const lookup = async <T>(
    key: string,
    setOptions?: CacheSetOptions,
  ): Promise<CacheEntry<T> | undefined> => {
    // A promotion is a write too. The ladder is one await per rung, so a bust can finish between
    // the far `get` and the near `set` — which promotes a value out of a tier nothing has cleared
    // yet into one that was cleared a millisecond ago. Fan-out order makes that window small; the
    // fence is what makes crossing it not matter.
    const fence = sampleFence({ key });
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
      fence.cover({ tags: hit.tags });
      const promotedInto: CacheTier[] = [];
      for (let up = 0; up < i; up += 1) {
        const closer = ordered[up];
        if (closer === undefined) continue;
        if (!fence.isValid()) {
          await rollback(promotedInto, key);
          break;
        }
        await bestEffort(closer.name, 'set', key, () => closer.set(key, hit.value, promoted));
        promotedInto.push(closer);
      }
      // Returned either way: this IS what a tier held when it was asked, and a fence never fails
      // a business read — it only declines to publish.
      return hit;
    }
    return undefined;
  };

  return {
    tiers: ordered,

    async read<T>(key: string, load: () => Promise<T>, setOptions?: CacheSetOptions): Promise<T> {
      // Outside the flight on purpose, and the cost is known: N concurrent misses each walk the
      // ladder before any of them joins, so a cold key pays N gets per rung. Moving it inside
      // would serialise every HIT behind whichever caller happened to arrive first — the common
      // case paying for the rare one. Carried as a Low; measure before changing it.
      const hit = await lookup<T>(key, setOptions);
      if (hit !== undefined) return hit.value;

      // The stampede guard. The homepage feed read 8,000x/s with a 60s lease misses for the whole
      // ~200ms `load()` takes, so ~1,600 identical queries reach Postgres at every TTL boundary
      // unless the arrivals inside that window join the read already running.
      return await flight.run<T, CacheSetOptions>(
        key,
        async (shared) => {
          // Sampled BEFORE `load()` — everything after this instant is a write this value has
          // not seen, and a fill that ignored it would hide that write for the whole TTL.
          const fence = sampleFence({
            key,
            ...(setOptions?.tags === undefined ? {} : { tags: setOptions.tags }),
          });
          const value = await load();
          // Joiners merged their own tags into the load they shared; covering is retroactive, so
          // a tag that arrived mid-load is fenced back to the sample rather than from now.
          const publish = async (options: CacheSetOptions | undefined): Promise<void> => {
            if (options?.tags !== undefined) fence.cover({ tags: options.tags });
            await fill(key, value, options, fence);
          };
          const merged = shared() ?? setOptions;
          await publish(merged);
          // The flight stays open until this whole `work` settles, and `fill` is one await per
          // rung — so a joiner can still merge a tag after the read above, and the entry that
          // landed would carry the leader's tags alone, which `invalidateTags` can never reach.
          // Re-read once and re-fill EVERY tier: re-reading per tier instead would land the near
          // tier — the one every later read hits first — with the FEWEST tags, so an invalidation
          // would clear the far rungs and leave the near one serving. A joiner arriving inside
          // the second pass is left where a plain cache hit already leaves one: reading a value
          // that was published without its tag.
          const late = shared() ?? setOptions;
          if (tagsAddedSince(merged, late)) await publish(late);
          return value;
        },
        { context: setOptions ?? {}, merge: mergeSetOptions },
      );
    },

    write<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
      // An explicit write is newer truth than any load already in flight for this key, so it
      // fences those fills off before it starts rather than losing a race with one.
      markInvalidated({ key });
      return fill(key, value, options);
    },

    async drop(key: string): Promise<void> {
      markInvalidated({ key });
      // Farthest tier first, for the reason `invalidateTags` fans out that way: clearing the near
      // tiers first leaves a window where a racing read finds the far tier still holding the old
      // value and promotes it back up, into tiers this call has already cleared.
      for (const tier of [...ordered].reverse()) {
        await bestEffort(tier.name, 'del', key, () => tier.del(key));
      }
    },
  };
}
