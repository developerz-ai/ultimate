// The tiers, and the hop between replicas. `createMemoTier`, `createLruTier` and `createRedisTier`
// had zero callers before this file's subject existed, so the failure case here is the one that
// shipped: a boot that registers only the CDN tier and leaves every cached read to be recomputed.

import { afterEach, describe, expect, test } from 'bun:test';
import type { PurgeDriver } from '@ultimat3/cache';
import {
  declareTags,
  invalidateTags,
  isolateDeclaredTags,
  isolateTiers,
  noopPurgeDriver,
  registeredTiers,
} from '@ultimat3/cache';
import { createContext } from '@ultimat3/core';
import { readThrough } from '@ultimat3/query';
import { InProcessTransport } from '@ultimat3/realtime';
import { CACHE_INVALIDATE_SUBJECT, startCacheTiers } from './dev-cache';

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
   * The failure this pins, end to end and through the real read path. `invalidateTags` fans out to
   * REGISTERED tiers; the tier a `cache:` query filled used to be `@ultimat3/query`'s own private
   * `ReadCache`, and on a boot with no `REDIS_URL` that seam was left as a module-default
   * `MemoryReadCache` — an object in no registry. Every `cache:` read on every non-Redis
   * deployment therefore served pre-write rows for the whole TTL while the report said
   * `errors: []`. This boot installs no read tier at all now, so there is nothing to leave unwired:
   * `readThrough` fills what `startCacheTiers` registered.
   */
  const cachedRead = (answer: string): (() => Promise<string>) => {
    return async () => answer;
  };

  test('a cache: read filled by this boot is dropped by an invalidateTags fan-out', async () => {
    restore = isolateTiers();
    declareTags(['post']);
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
    });
    const key = 'query:feed:actor:fingerprint:post';
    const read = (answer: string): Promise<string> =>
      readThrough(createContext({}), key, 60_000, cachedRead(answer), [{ entity: 'post' }]);

    expect(await read('pre-write')).toBe('pre-write');
    // A second request: the per-request memo is a different object, so only the registered ladder
    // can be what answers with the first read's rows.
    expect(await read('post-write')).toBe('pre-write');

    await invalidateTags([{ entity: 'post' }]);

    expect(await read('post-write')).toBe('post-write');
  });

  test('the release leaves no tier behind, so a stopped process caches for nobody', async () => {
    restore = isolateTiers();
    const stop = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
    });
    await stop();

    expect(registeredTiers()).toEqual([]);
    // And the read path degrades to "no cache" rather than to a private store nothing can reach.
    const key = 'query:feed:actor:after-release';
    let executed = 0;
    const run = async (): Promise<number> => {
      executed += 1;
      return executed;
    };
    await readThrough(createContext({}), key, 60_000, run, []);
    await readThrough(createContext({}), key, 60_000, run, []);
    expect(executed).toBe(2);
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
