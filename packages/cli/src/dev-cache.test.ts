// The tiers, and the hop between replicas. `createMemoTier`, `createLruTier` and `createRedisTier`
// had zero callers before this file's subject existed, so the failure case here is the one that
// shipped: a boot that registers only the CDN tier and leaves every cached read to be recomputed.

import { afterEach, describe, expect, test } from 'bun:test';
import type { CacheTag, CacheTier, PurgeDriver } from '@ultimat3/cache';
import {
  declareTags,
  invalidateTags,
  isolateDeclaredTags,
  isolateTiers,
  noopPurgeDriver,
  registeredTiers,
} from '@ultimat3/cache';
import { getReadCache, MemoryReadCache } from '@ultimat3/query';
import { InProcessTransport } from '@ultimat3/realtime';
import { CACHE_INVALIDATE_SUBJECT, startCacheTiers, tierReadCache } from './dev-cache';

let release: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
// `isolateDeclaredTags` and not a bare `declareTags([])`: the tag registry is process-global, and
// a file that leaves it dirty is X_TEST_REGISTRY_LEAK for whichever suite runs next.
const restoreTags = isolateDeclaredTags();

afterEach(async () => {
  await release?.();
  release = undefined;
  restore?.();
  restore = undefined;
  restoreTags();
});

const recordingPurge = (): PurgeDriver => ({
  name: 'recording',
  async purge(keys) {
    return keys;
  },
  async purgeAll() {},
});

describe('which tiers a boot registers', () => {
  test('with no REDIS_URL: the two that need no external state, and no shared tier', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
    });
    expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo', 'lru']);
  });

  test('REDIS_URL adds the shared tier — the one that makes a second replica cheap', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: { REDIS_URL: 'redis://localhost:6379' },
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
    });
    // Registered, never dialled: `createRedisTier` resolves `Bun.redis` lazily, so selection is
    // pure here exactly as the mail and transport selections are.
    expect(registeredTiers().map((tier) => tier.name)).toContain('redis');
  });

  test('a real edge adds the cdn tier; a noop purge driver adds nothing', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: {},
      purge: recordingPurge(),
      transport: new InProcessTransport(),
    });
    expect(registeredTiers().map((tier) => tier.name)).toContain('cdn');
  });

  test('the release drops the whole registry, so a stopped process purges for nobody', async () => {
    restore = isolateTiers();
    const stop = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
    });
    expect(registeredTiers().length).toBeGreaterThan(0);
    await stop();
    expect(registeredTiers()).toEqual([]);
  });
});

describe("the read tier an action's cache.invalidates has to reach", () => {
  /**
   * The failure this pins: `invalidateTags` fans out to REGISTERED tiers, the read tier a `cache:`
   * query fills through is `@ultimat3/query`'s own seam, and on a boot with no `REDIS_URL` that
   * seam was left as the module-default `MemoryReadCache` — an object in no registry, which
   * nothing in the framework called `invalidateQueryTags` on. Every `cache:` read on every
   * non-Redis deployment therefore served pre-write rows for the whole TTL while the invalidation
   * report said `errors: []`.
   */
  const fillReadCache = async (): Promise<string> => {
    const key = 'query:feed:fingerprint:post';
    await getReadCache().set(key, {
      value: ['pre-write'],
      expiresAt: Date.now() + 60_000,
      tags: [{ entity: 'post' }],
    });
    return key;
  };

  test('with no REDIS_URL an invalidateTags fan-out drops the read entry', async () => {
    restore = isolateTiers();
    declareTags(['post']);
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
    });
    const key = await fillReadCache();
    expect(await getReadCache().get(key)).toBeDefined();

    await invalidateTags([{ entity: 'post' }]);

    expect(await getReadCache().get(key)).toBeUndefined();
  });

  test('the release puts the process back on an unwired read cache', async () => {
    restore = isolateTiers();
    const stop = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
    });
    await stop();
    expect(getReadCache()).toBeInstanceOf(MemoryReadCache);
  });
});

describe('cross-instance invalidation', () => {
  test('a local bust is published on the wire', async () => {
    restore = isolateTiers();
    declareTags(['post']);
    const transport = new InProcessTransport();
    const seen: string[] = [];
    await transport.subscribe(CACHE_INVALIDATE_SUBJECT, (payload) => {
      seen.push(payload);
    });
    release = startCacheTiers({ env: {}, purge: noopPurgeDriver(), transport });

    await invalidateTags([{ entity: 'post', id: '1' }]);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] as string)).toEqual(['post:1']);
  });

  test("a peer's frame is applied here, and applying it publishes nothing back", async () => {
    restore = isolateTiers();
    declareTags(['post']);
    const transport = new InProcessTransport();
    release = startCacheTiers({ env: {}, purge: noopPurgeDriver(), transport });
    // Two frames arrive; if inbound re-emitted, the count would climb without bound. Re-entrancy
    // is structural — `receiveInvalidationBroadcast` is the only caller that suppresses `emit`,
    // and `emit` is not a public parameter — so this pins the property, not a flag.
    const seen: string[] = [];
    await transport.subscribe(CACHE_INVALIDATE_SUBJECT, (payload) => {
      seen.push(payload);
    });
    await transport.publish(CACHE_INVALIDATE_SUBJECT, JSON.stringify(['post:9']));
    await Bun.sleep(10);
    expect(seen).toEqual([JSON.stringify(['post:9'])]);
  });

  test('a malformed frame never kills the subscriber loop', async () => {
    restore = isolateTiers();
    const transport = new InProcessTransport();
    release = startCacheTiers({ env: {}, purge: noopPurgeDriver(), transport });
    // A throw here would silently end cross-instance invalidation for the whole process — the
    // exact failure the hop exists to prevent, arriving quietly.
    await transport.publish(CACHE_INVALIDATE_SUBJECT, 'not json');
    await transport.publish(CACHE_INVALIDATE_SUBJECT, '{"not":"an array"}');
    await Bun.sleep(10);
    expect(registeredTiers().length).toBeGreaterThan(0);
  });
});

describe('one tier, seen as the query read cache', () => {
  const fakeTier = (): CacheTier & { readonly writes: Map<string, unknown> } => {
    const writes = new Map<string, unknown>();
    const expiries = new Map<string, number>();
    const deleted: string[] = [];
    return {
      name: 'redis',
      writes,
      async get<T>(key: string) {
        if (!writes.has(key)) return undefined;
        const expiresAt = expiries.get(key);
        return {
          value: writes.get(key) as T,
          tags: [] as readonly CacheTag[],
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
      },
      async set<T>(key: string, value: T, options?: { ttlMs?: number }) {
        writes.set(key, value);
        if (options?.ttlMs !== undefined) expiries.set(key, Date.now() + options.ttlMs);
      },
      async del(key: string) {
        writes.delete(key);
        deleted.push(key);
      },
      async invalidateTags(tags: readonly CacheTag[]) {
        return { tier: 'redis' as const, keys: tags.map((tag) => tag.entity) };
      },
    };
  };

  test('a miss is undefined and a hit carries the tier’s own remaining lease', async () => {
    const tier = fakeTier();
    const cache = tierReadCache(tier);
    expect(await cache.get('a')).toBeUndefined();
    await cache.set('a', { value: 1, expiresAt: Date.now() + 60_000 });
    const hit = await cache.get('a');
    expect(hit?.value).toEqual(1);
    // Not `null`: discarding the expiry promotes a key one second from expiry as fresh.
    expect(hit?.expiresAt).toBeGreaterThan(Date.now());
  });

  test('an entry already stale on arrival is a drop, never a write the tier would refuse', async () => {
    const tier = fakeTier();
    const cache = tierReadCache(tier);
    // Every tier refuses a non-positive `ttlMs` with X_CACHE_TTL_INVALID, so a naive
    // `expiresAt - now` would turn a late write into a thrown error inside a read.
    await cache.set('a', { value: 1, expiresAt: Date.now() - 1 });
    expect(tier.writes.has('a')).toBe(false);
  });

  test('a null expiry falls to the tier’s own default rather than meaning "never"', async () => {
    const tier = fakeTier();
    await tierReadCache(tier).set('a', { value: 1, expiresAt: null });
    expect(tier.writes.get('a')).toEqual(1);
  });

  test('invalidateTags answers the keys the tier dropped', async () => {
    const cache = tierReadCache(fakeTier());
    expect(await cache.invalidateTags?.([{ entity: 'post' }])).toEqual(['post']);
  });
});
