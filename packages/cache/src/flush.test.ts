// `flushProcessTiers()`: what a process does when it cannot know which busts it missed. Its bus
// connection was down for a window nobody measured, so every peer's invalidation in that window is
// lost to it — and the only correct answer to "which entries are stale" is "any of them".

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sampleFence } from './fence';
import { isolateGraph, registerDependent, resetGraph } from './graph';
import {
  flushProcessTiers,
  isolateTiers,
  recentInvalidations,
  registerInvalidationBroadcast,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
import { lruTier } from './lru';
import { isolateDeclaredTags, resetDeclaredTags, tag } from './tags';
import type { CacheTier } from './tiers';

const restoreRegistries = [isolateTiers(), isolateDeclaredTags(), isolateGraph()];

beforeEach(() => {
  resetTiers();
  resetDeclaredTags();
  resetGraph();
});

afterAll(() => {
  for (const restore of restoreRegistries) restore();
});

/** A tier other processes write too: it was cleared by whoever ran the bust, so it has no `clear`. */
const sharedTier = (): CacheTier & { cleared: number } => {
  const tier = {
    name: 'redis' as const,
    cleared: 0,
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
    invalidateTags: async () => {
      tier.cleared += 1;
      return { tier: 'redis' as const, keys: [] };
    },
  };
  return tier;
};

describe('flushProcessTiers', () => {
  test('drops every in-process entry — tagged, untagged, whatever a peer may have busted', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    const redis = sharedTier();
    registerTier(lru);
    registerTier(redis);
    await lru.set('post:1', 'old', { tags: [tag('post', '1')] });
    await lru.set('feed', ['a'], { tags: [tag('post')] });
    await lru.set('untagged', 1);

    const report = await flushProcessTiers('cache.bus-reconnect');

    expect(await lru.get('post:1')).toBeUndefined();
    expect(await lru.get('feed')).toBeUndefined();
    expect(await lru.get('untagged')).toBeUndefined();
    // The shared tier is not this process's to empty: the bust's sender already cleared it.
    expect(redis.cleared).toBe(0);
    expect(report.tags).toEqual(['*']);
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['lru']);
    expect(report.errors).toEqual([]);
  });

  test('marks every tag-revalidated ISR page stale: a peer bust reaches them by no other road', async () => {
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    registerDependent([tag('post', '1'), tag('author', '9')], { kind: 'isr-route', id: '/blog/1' });
    registerDependent([tag('post')], { kind: 'live-query', id: 'q1' });
    const marked: string[] = [];
    registerRevalidator((path) => {
      marked.push(path);
    });

    const report = await flushProcessTiers('cache.bus-reconnect');

    expect([...marked].sort()).toEqual(['/blog', '/blog/1']);
    expect([...report.isr].sort()).toEqual(['/blog', '/blog/1']);
  });

  test('a fill that was already loading cannot republish what the flush dropped', async () => {
    const fence = sampleFence({ key: 'post:1', tags: [tag('post', '1')] });
    expect(fence.isValid()).toBe(true);

    await flushProcessTiers('cache.bus-reconnect');

    expect(fence.isValid()).toBe(false);
    // One taken afterwards is unaffected: the flush is an instant, not a mode.
    expect(sampleFence({ key: 'post:1' }).isValid()).toBe(true);
  });

  test('never re-emits, is recorded under its source, and survives a tier that will not clear', async () => {
    let sends = 0;
    registerInvalidationBroadcast(() => {
      sends += 1;
    });
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier({
      ...lru,
      clear: () => Promise.reject(new RangeError('the tier refused')),
    });

    const report = await flushProcessTiers('cache.broadcast');

    expect(sends).toBe(0);
    expect(report.errors).toEqual([{ tier: 'lru', message: expect.stringContaining('refused') }]);
    expect(recentInvalidations()[0]?.source).toBe('cache.broadcast');
    expect(recentInvalidations()[0]?.tags).toEqual(['*']);
  });
});
