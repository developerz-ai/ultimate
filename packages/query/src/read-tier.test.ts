// Single responsibility: WHERE a `cache:` read's entry lives. The answer is "the tiers
// `@ultimat3/cache` has registered", and nowhere else — this package no longer owns a store.
//
// The failure this replaces: the read tier was a private `ReadCache` seam registered nowhere, so
// `invalidateTags` — which walks the registered tiers and nothing else — could not reach it. The
// gap was closed by a wiring trick in `packages/cli/src/dev-cache.ts` that installed the read
// cache over an object it also registered, and that trick carried a second `ReadCache`
// implementation dating entries with `Date.now()`. Both are gone; these are the properties that
// have to hold without them.

import { afterEach, describe, expect, test } from 'bun:test';
import type { CacheSetOptions, CacheTag, CacheTier, TierName } from '@ultimat3/cache';
import {
  createLruTier,
  declareTags,
  invalidateTags,
  isolateDeclaredTags,
  isolateTiers,
  registerTier,
  tag,
} from '@ultimat3/cache';
import { createContext, frozenClock } from '@ultimat3/core';
import { readThrough } from './cache';

let restore: (() => void) | undefined;
const restoreTags = isolateDeclaredTags();
declareTags(['post']);

afterEach(() => {
  restore?.();
  restore = undefined;
  restoreTags();
});

/** Records what each rung was asked, so "which rung answered" is a list and not a claim. */
function recordingTier(name: TierName): CacheTier & { readonly gets: string[] } {
  const entries = new Map<
    string,
    { readonly value: unknown; readonly tags: readonly CacheTag[] }
  >();
  const gets: string[] = [];
  return {
    name,
    gets,
    async get<T>(key: string) {
      gets.push(key);
      const held = entries.get(key);
      return held === undefined ? undefined : { value: held.value as T, tags: held.tags };
    },
    async set<T>(key: string, value: T, options?: CacheSetOptions) {
      entries.set(key, { value, tags: options?.tags ?? [] });
    },
    async del(key: string) {
      entries.delete(key);
    },
    async invalidateTags() {
      const keys = [...entries.keys()];
      entries.clear();
      return { tier: name, keys };
    },
  };
}

describe("the read tier an action's cache.invalidates has to reach", () => {
  /**
   * The whole of C3 in one test: nothing here installs a read cache, and nothing has to. The
   * entry is in the registry, so the one fan-out drops it.
   */
  test('a cache: read fills the registered tiers, and invalidateTags drops it', async () => {
    restore = isolateTiers();
    registerTier(createLruTier());
    let executed = 0;
    const run = async (): Promise<string> => {
      executed += 1;
      return `rows-${executed}`;
    };

    expect(await readThrough(createContext({}), 'k', 60_000, run, [tag('post')])).toBe('rows-1');
    // A second request, so the per-request memo cannot be what answers.
    expect(await readThrough(createContext({}), 'k', 60_000, run, [tag('post')])).toBe('rows-1');
    expect(executed).toBe(1);

    await invalidateTags([tag('post')]);

    expect(await readThrough(createContext({}), 'k', 60_000, run, [tag('post')])).toBe('rows-2');
    expect(executed).toBe(2);
  });

  /**
   * The detail that proves the migration rather than merely surviving it. `tierReadCache` derived
   * a lease with `Date.now()` before handing it to the tier, so a tier registered with a frozen
   * clock still expired by the wall clock and no test could drive the Redis-backed read path.
   * Nothing here reads a wall clock: the read passes a RELATIVE `ttlMs` and the tier's own clock
   * turns it into an absolute expiry.
   */
  test("the tier's own clock decides the expiry, so a frozen clock drives the whole read path", async () => {
    restore = isolateTiers();
    const clock = frozenClock(1_000);
    // `jitterFraction: 0` because the default shaves a random slice off every lease — correct in
    // production, and exactly what a deterministic assertion may not inherit.
    const lru = createLruTier({ clock, jitterFraction: 0 });
    registerTier(lru);

    await readThrough(createContext({ clock }), 'k', 60_000, async () => 'rows', [tag('post')]);

    expect((await lru.get('k'))?.expiresAt).toBe(61_000);
  });

  /**
   * The read half of the same clock. A stack reading the wall clock over a tier holding a
   * frozen-clock expiry calls every entry expired, so this is what makes the hit above reachable.
   */
  test('an entry written under a frozen clock is still a hit under that clock', async () => {
    restore = isolateTiers();
    const clock = frozenClock(1_000);
    registerTier(createLruTier({ clock, jitterFraction: 0 }));
    let executed = 0;
    const run = async (): Promise<number> => {
      executed += 1;
      return executed;
    };

    await readThrough(createContext({ clock }), 'k', 60_000, run, []);
    await readThrough(createContext({ clock }), 'k', 60_000, run, []);

    expect(executed).toBe(1);
  });

  /**
   * What a Redis deployment's read path becomes. It used to be `tierReadCache(shared)` — the
   * shared tier ALONE — so every cached read was a network round trip and this process's own LRU
   * was never consulted for one. The ladder is read down and promoted up, so the next reader stops
   * at the near rung.
   */
  test('reads walk down to the shared tier and promote up, so the next read stops nearer', async () => {
    restore = isolateTiers();
    const lru = recordingTier('lru');
    const redis = recordingTier('redis');
    registerTier(redis);
    registerTier(lru);
    let executed = 0;
    const run = async (): Promise<string> => {
      executed += 1;
      return 'rows';
    };

    await readThrough(createContext({}), 'k', 60_000, run, []);
    // The fill writes every rung, so a second replica finds it too.
    expect(await redis.get('k')).toBeDefined();
    expect(await lru.get('k')).toBeDefined();

    redis.gets.length = 0;
    await readThrough(createContext({}), 'k', 60_000, run, []);

    expect(executed).toBe(1);
    // The near rung answered, so the far one was never asked — the round trip this saves.
    expect(redis.gets).toEqual([]);
  });

  /**
   * A process that registered nothing — a script, a worker boot, a test — reads uncached rather
   * than filling a store no fan-out can see. That is the trade the private seam is gone for, and
   * it is stated rather than discovered.
   */
  test('with no tier registered the read is uncached, and still correct', async () => {
    restore = isolateTiers();
    let executed = 0;
    const run = async (): Promise<number> => {
      executed += 1;
      return executed;
    };

    expect(await readThrough(createContext({}), 'k', 60_000, run, [])).toBe(1);
    expect(await readThrough(createContext({}), 'k', 60_000, run, [])).toBe(2);
  });
});
