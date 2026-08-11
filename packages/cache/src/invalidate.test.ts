import { beforeEach, describe, expect, test } from 'bun:test';
import { systemClock, withSpan } from '@ultimat3/core';
import { CacheDriverUnavailableError, CacheTagUnknownError } from './errors';
import { registerDependent, resetGraph } from './graph';
import type { InvalidationEvent } from './invalidate';
import {
  invalidateTags,
  invalidateWireTags,
  recentInvalidations,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
import { createLruTier } from './lru';
import type { RedisLike } from './redis';
import { createRedisTier } from './redis';
import { declareTags, resetDeclaredTags, tag } from './tags';
import type { CacheTier, TierInvalidation } from './tiers';

function fakeRedis(): RedisLike & { readonly sent: string[][] } {
  const sets = new Map<string, Set<string>>();
  const values = new Map<string, string>();
  const sent: string[][] = [];
  return {
    sent,
    get(key) {
      return Promise.resolve(values.get(key) ?? null);
    },
    set(key, value) {
      values.set(key, value);
      return Promise.resolve('OK');
    },
    send(command, args) {
      sent.push([command, ...args]);
      if (command === 'SET') {
        values.set(String(args[0]), String(args[1]));
        return Promise.resolve('OK');
      }
      if (command === 'SADD') {
        const bucket = String(args[0]);
        const existing = sets.get(bucket) ?? new Set<string>();
        existing.add(String(args[1]));
        sets.set(bucket, existing);
        return Promise.resolve(1);
      }
      if (command === 'DEL') {
        values.delete(String(args[0]));
        return Promise.resolve(1);
      }
      if (command === 'EVAL') {
        // Mirrors INVALIDATE_SCRIPT: members of every tag set, then drop the sets.
        const count = Number(args[1]);
        const buckets = args.slice(2, 2 + count);
        const removed: string[] = [];
        for (const bucket of buckets) {
          for (const member of sets.get(bucket) ?? []) {
            values.delete(member);
            removed.push(member);
          }
          sets.delete(bucket);
        }
        return Promise.resolve(removed);
      }
      return Promise.resolve(null);
    },
  };
}

const cdnSpy = (): CacheTier & { readonly purged: string[] } => {
  const purged: string[] = [];
  return {
    name: 'cdn',
    purged,
    get() {
      return Promise.resolve(undefined);
    },
    set() {
      return Promise.resolve();
    },
    del() {
      return Promise.resolve();
    },
    invalidateTags(tags): Promise<TierInvalidation> {
      const keys = tags.map((value) =>
        value.id === undefined ? value.entity : `${value.entity}:${value.id}`,
      );
      purged.push(...keys);
      return Promise.resolve({ tier: 'cdn', keys });
    },
  };
};

/**
 * A tier whose store is gone. It rejects with the coded error a real dead Redis raises rather than
 * a bare `Error`, which is what pins the useful half of `report.errors`: the code survives the hop
 * into the report, so "which tier, and why" is answerable from the `/_x` panel alone.
 */
const brokenRedisTier = (): CacheTier => ({
  name: 'redis',
  get() {
    return Promise.resolve(undefined);
  },
  set() {
    return Promise.resolve();
  },
  del() {
    return Promise.resolve();
  },
  invalidateTags() {
    return Promise.reject(
      new CacheDriverUnavailableError({
        driver: 'redis',
        cause: 'ECONNREFUSED',
        fix: 'x doctor --json',
      }),
    );
  },
});

beforeEach(() => {
  resetTiers();
  resetGraph();
  resetDeclaredTags();
});

describe('invalidateTags fan-out', () => {
  test('reaches every registered tier and reports what each one dropped', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 0 });
    const redis = createRedisTier({ client: fakeRedis() });
    const cdn = cdnSpy();
    // Registered out of order on purpose: the stack must normalise to TIER_ORDER.
    registerTier(cdn);
    registerTier(redis);
    registerTier(lru);

    await lru.set('feed', ['a'], { tags: [tag('post')] });
    await redis.set('feed', ['a'], { tags: [tag('post')] });
    await lru.set('users', ['u'], { tags: [tag('user')] });

    const report = await invalidateTags([tag('post')]);

    expect(report.tags).toEqual(['post']);
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['lru', 'redis', 'cdn']);
    expect(report.errors).toEqual([]);

    const byTier = new Map(report.tiers.map((entry) => [entry.tier, entry.keys]));
    expect(byTier.get('lru')).toEqual(['feed']);
    expect(byTier.get('redis')).toEqual(['feed']);
    expect(byTier.get('cdn')).toEqual(['post']);
    expect(cdn.purged).toEqual(['post']);

    // The untagged-by-post entry survives the fan-out.
    expect(await lru.get('users')).toBeDefined();
    expect(await redis.get('feed')).toBeUndefined();
  });

  test('a failing tier is reported, never thrown — the write that triggered it must not fail', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 0 });
    registerTier(lru);
    registerTier(brokenRedisTier());
    await lru.set('k', 1, { tags: [tag('post')] });

    const report = await invalidateTags([tag('post')]);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.tier).toBe('redis');
    expect(report.errors[0]?.message).toContain('X_CACHE_DRIVER_UNAVAILABLE');
    expect(report.errors[0]?.message).toContain('ECONNREFUSED');
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['lru']);
    expect(await lru.get('k')).toBeUndefined();
  });

  test('ISR routes and CDN paths come from the one graph, not a second registry', async () => {
    const revalidated: string[] = [];
    registerRevalidator((path) => {
      revalidated.push(path);
    });
    registerDependent([tag('post', '1')], { kind: 'isr-route', id: '/blog/hello' });
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    registerDependent([tag('post')], { kind: 'cdn-path', id: '/feed.xml' });
    registerDependent([tag('user')], { kind: 'isr-route', id: '/authors' });

    const report = await invalidateTags([tag('post', '1')]);

    expect([...report.isr].sort()).toEqual(['/blog', '/blog/hello']);
    expect(report.cdn).toEqual(['/feed.xml']);
    expect([...revalidated].sort()).toEqual(['/blog', '/blog/hello']);
  });

  test('an undeclared tag fails loudly once entities have been declared', async () => {
    declareTags(['post', 'user']);
    await expect(invalidateWireTags(['pots'])).rejects.toThrow(CacheTagUnknownError);
    await expect(invalidateWireTags(['post:1'])).resolves.toBeDefined();
  });
});

describe('recentInvalidations log', () => {
  test('an invalidation is recorded with its wire tags, its duration and the keys every tier reported', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 0 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });

    const report = await invalidateTags([tag('post')]);

    const [event] = recentInvalidations();
    expect(event?.tags).toEqual(report.tags);
    expect(event?.durationMs).toBe(report.durationMs);
    expect(event?.busted).toContain('feed');
  });

  test('busted includes ISR paths, CDN paths and live queries, not just tier keys, and has no duplicates', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 0 });
    const cdn = cdnSpy();
    registerTier(lru);
    registerTier(cdn);
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    registerDependent([tag('post')], { kind: 'cdn-path', id: '/feed.xml' });
    registerDependent([tag('post')], { kind: 'live-query', id: 'live:post-list' });
    // Same key the cdn tier itself reports for this tag — exercises the de-dup, not just the union.
    await lru.set('post', ['a'], { tags: [tag('post')] });

    await invalidateTags([tag('post')]);

    const [event] = recentInvalidations();
    expect(event?.busted).toEqual(['post', '/blog', '/feed.xml', 'live:post-list']);
  });

  test('newest first, and the log never grows past the cap (drive it past 100)', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 0 });
    registerTier(lru);

    for (let i = 0; i < 105; i += 1) {
      await invalidateTags([tag('post', String(i))]);
    }

    const log = recentInvalidations();
    expect(log.length).toBe(100);
    expect(log[0]?.tags).toEqual(['post:104']);
    expect(log[99]?.tags).toEqual(['post:5']);
  });

  test('source is the calling span name when invalidateTags runs inside a withSpan call', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 0 });
    registerTier(lru);

    await withSpan('job.reindex', () => invalidateTags([tag('post')]));

    const [event] = recentInvalidations();
    expect(event?.source).toBe('job.reindex');
  });

  test('source falls back to the literal invalidateTags when there is no active span', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 0 });
    registerTier(lru);

    await invalidateTags([tag('post')]);

    const [event] = recentInvalidations();
    expect(event?.source).toBe('invalidateTags');
  });

  test('a tier that throws still records an event, and its errors names the tier', async () => {
    registerTier(brokenRedisTier());

    await invalidateTags([tag('post')]);

    const [event] = recentInvalidations();
    expect(event?.errors).toHaveLength(1);
    expect(event?.errors[0]?.tier).toBe('redis');
    expect(event?.errors[0]?.message).toContain('ECONNREFUSED');
  });

  test('recentInvalidations hands back a copy: mutating it does not change the next answer', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 0 });
    registerTier(lru);
    await invalidateTags([tag('post')]);

    const first = recentInvalidations() as InvalidationEvent[];
    first.push({
      at: 'bogus',
      tags: [],
      busted: [],
      source: 'test',
      durationMs: 0,
      errors: [],
    });

    expect(recentInvalidations().length).toBe(1);
  });

  test('resetTiers clears the log', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 0 });
    registerTier(lru);
    await invalidateTags([tag('post')]);
    expect(recentInvalidations().length).toBe(1);

    resetTiers();

    expect(recentInvalidations()).toEqual([]);
  });

  test('invalidateWireTags records exactly one event, not two', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 0 });
    registerTier(lru);

    await invalidateWireTags(['post']);

    expect(recentInvalidations().length).toBe(1);
  });

  test('at is an ISO-8601 timestamp from the frozen system clock', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 0 });
    registerTier(lru);
    const before = systemClock.now().toISOString();

    await invalidateTags([tag('post')]);

    const [event] = recentInvalidations();
    expect(event?.at).toBe(before);
  });
});
