import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { currentSpan, subscribe, withSpan } from '@ultimat3/core';
import { recordCacheEvents } from './cache-events-fixture';
import { cdnTier } from './cdn';
import { CacheDriverUnavailableError, CacheTagUnknownError } from './errors';
import { dependentsOfKind, isolateGraph, registerDependent, resetGraph } from './graph';
import {
  invalidateTags,
  invalidateWireTags,
  isolateTiers,
  receiveInvalidationBroadcast,
  registeredTiers,
  registerInvalidationBroadcast,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
import { lruTier } from './lru';
import { redisTier } from './redis';
import { fakeRedis } from './redis-fake-fixture';
import { declareTags, isolateDeclaredTags, knownTags, resetDeclaredTags, tag } from './tags';
import type { CacheTier, TierInvalidation } from './tiers';

const events = recordCacheEvents();

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

function clearRegistries(): void {
  resetTiers();
  resetGraph();
  resetDeclaredTags();
}

/**
 * `clearRegistries()` is this file's per-test isolation; running it LAST would take a NEIGHBOURING
 * file's tiers, graph edges and declarations with it. One restore per registry, each from the
 * module that owns the state.
 */
function isolateRegistries(): () => void {
  const restores = [isolateTiers(), isolateGraph(), isolateDeclaredTags()];
  return () => {
    for (const restore of restores) restore();
  };
}

// Taken at module scope, so the baseline is whatever was registered before this file's first test.
const restoreRegistries = isolateRegistries();

beforeEach(clearRegistries);

// The tiers this file registers are process-wide: without this the LAST test's tier stayed in the
// registry for every file that ran after it in the same `bun test` process.
afterAll(restoreRegistries);

describe('invalidateTags fan-out', () => {
  test('reaches every registered tier and reports what each one dropped', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    // `buildId: null` so the canned member below can name the value key without reading
    // `appVersion()`; the namespace is `redis.test.ts`'s subject, not this file's.
    const client = fakeRedis();
    const redis = redisTier({ client, buildId: null });
    const cdn = cdnSpy();
    // Registered out of order on purpose: the stack must normalise to CACHE_TIERS order.
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
    const lru = lruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
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

  /**
   * "Never throws for a tier failure" is the contract at the top of `invalidateTags`, and it held
   * only for refusals the framework itself built: a tier, a revalidator and a broadcast are all
   * app-supplied, so the value they reject with is app-supplied too. `instanceof` runs a `Proxy`'s
   * `getPrototypeOf` trap and `String()` runs `Symbol.toPrimitive`, so rendering the refusal for
   * `report.errors` used to raise INSTEAD of the refusal — and the raise lands on the write that
   * triggered the bust, which is the one caller this whole path exists to protect.
   */
  describe('a refusal that fights being rendered still lands in report.errors', () => {
    const trapped = (): unknown =>
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new TypeError('proxy trap');
          },
        },
      );

    test('a tier rejecting with a hostile throwable', async () => {
      registerTier({
        name: 'redis',
        get: () => Promise.resolve(undefined),
        set: () => Promise.resolve(),
        del: () => Promise.resolve(),
        invalidateTags: () => Promise.reject(trapped()),
      });

      const report = await invalidateTags([tag('post')]);

      expect(report.errors.map((entry) => entry.tier)).toEqual(['redis']);
      expect(typeof report.errors[0]?.message).toBe('string');
    });

    test('a revalidator rejecting with a hostile throwable', async () => {
      registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
      registerRevalidator(() => Promise.reject(Object.create(null) as unknown));

      const report = await invalidateTags([tag('post')]);

      expect(report.errors.map((entry) => entry.tier)).toEqual(['isr']);
      expect(report.isr).toEqual(['/blog']);
    });

    test('a broadcast rejecting with a hostile throwable', async () => {
      registerInvalidationBroadcast(() => Promise.reject(trapped()));

      const report = await invalidateTags([tag('post')]);

      expect(report.errors.map((entry) => entry.tier)).toEqual(['broadcast']);
      expect(typeof report.errors[0]?.message).toBe('string');
    });
  });

  test('an undeclared tag fails loudly once entities have been declared', async () => {
    declareTags(['post', 'user']);
    await expect(invalidateWireTags(['pots'])).rejects.toThrow(CacheTagUnknownError);
    await expect(invalidateWireTags(['post:1'])).resolves.toBeDefined();
  });
});

describe('the cache.invalidate event', () => {
  test('an invalidation is recorded with its wire tags, its duration and the keys every tier reported', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });

    const report = await invalidateTags([tag('post')]);

    const [event] = events.invalidations();
    expect(event?.tags).toEqual(report.tags);
    expect(event?.durationMs).toBe(report.durationMs);
    expect(event?.busted).toContain('feed');
  });

  test('busted includes ISR paths, live queries and what the CDN tier actually purged, with no duplicates', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    const purged: string[] = [];
    registerTier(lru);
    registerTier(
      cdnTier({
        purge: {
          name: 'recording',
          purge: (keys) => {
            purged.push(...keys);
            return Promise.resolve(keys);
          },
          purgeAll: () => Promise.resolve(),
        },
      }),
    );
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    registerDependent([tag('post')], { kind: 'cdn-path', id: '/feed.xml' });
    registerDependent([tag('post')], { kind: 'live-query', id: 'live:post-list' });
    // Same key the cdn tier itself reports for this tag — exercises the de-dup, not just the union.
    await lru.set('post', ['a'], { tags: [tag('post')] });

    await invalidateTags([tag('post')]);

    // The path is not merely *reported* busted: the driver was actually asked to purge it.
    expect(purged).toEqual(['e:post', 'post', '/feed.xml']);
    const [event] = events.invalidations();
    expect(event?.busted).toEqual(['post', 'e:post', '/feed.xml', '/blog', 'live:post-list']);
  });

  test('with no CDN tier registered, a cdn-path is a dependent and never a bust', async () => {
    // `report.cdn` came from the graph and was folded into `busted` whether or not anything
    // purged it, so `x cache bust --json` named `/blog/hello` cleared while the edge held it
    // for its whole s-maxage. A partial bust that reads as a clean one is the failure the log
    // exists to catch.
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    registerDependent([tag('post', '1')], { kind: 'cdn-path', id: '/blog/hello' });

    const report = await invalidateTags([tag('post', '1')]);

    expect(report.cdn).toEqual(['/blog/hello']);
    const [event] = events.invalidations();
    expect(event?.busted).not.toContain('/blog/hello');
  });

  test('one event per bust, newest first, carrying no timestamp', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);

    await invalidateTags([tag('post', '1')]);
    await invalidateTags([tag('post', '2')]);

    const log = events.invalidations();
    expect(log.map((event) => event.tags)).toEqual([['post:2'], ['post:1']]);
    // A subscriber reads the clock itself; the payload is core's shape.
    expect(Object.keys(log[0] ?? {}).sort()).toEqual([
      'busted',
      'durationMs',
      'errors',
      'source',
      'tags',
    ]);
  });

  // What the `/_x` panel shows as "triggered by": the span that called `invalidateTags`, read at
  // the call — inside the fan-out the active span is already `cache.invalidate` itself.
  test('source is the calling span name when invalidateTags runs inside a withSpan call', async () => {
    registerTier(lruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 }));

    await withSpan('job.reindex', () => invalidateTags([tag('post')]));

    expect(events.invalidations()[0]?.source).toBe('job.reindex');
  });

  test('source falls back to the literal invalidateTags when there is no active span', async () => {
    registerTier(lruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 }));

    await invalidateTags([tag('post')]);

    expect(events.invalidations()[0]?.source).toBe('invalidateTags');
  });

  test('an inbound broadcast is sourced cache.broadcast', async () => {
    registerTier(lruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 }));

    await withSpan('nats.message', () => receiveInvalidationBroadcast(['post']));

    expect(events.invalidations()[0]?.source).toBe('cache.broadcast');
  });

  test('the subscriber runs inside the cache.invalidate span, a child of the caller', async () => {
    const lru = lruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    const seen: string[] = [];
    const off = subscribe('cache.invalidate', () => void seen.push(currentSpan()?.name ?? ''));
    try {
      await withSpan('job.reindex', () => invalidateTags([tag('post')]));
    } finally {
      off();
    }

    expect(seen).toEqual(['cache.invalidate']);
  });

  test('a tier that throws still records an event, and its errors names the tier', async () => {
    registerTier(brokenRedisTier());

    await invalidateTags([tag('post')]);

    const [event] = events.invalidations();
    expect(event?.errors).toHaveLength(1);
    expect(event?.errors[0]?.tier).toBe('redis');
    expect(event?.errors[0]?.message).toContain('ECONNREFUSED');
  });

  test('invalidateWireTags records exactly one event, not two', async () => {
    const lru = lruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);

    await invalidateWireTags(['post']);

    expect(events.invalidations().length).toBe(1);
  });
});

describe('the suite baseline this file hands back', () => {
  test("a neighbour's tier, graph edge and declared tag all survive this file's cleanup", () => {
    // Stand-ins for whatever an earlier file in the same `bun test` process left registered.
    registerTier(cdnSpy());
    registerDependent([tag('post', '9')], { kind: 'isr-route', id: '/neighbour' });
    declareTags(['neighbour']);

    const restore = isolateRegistries();
    clearRegistries();
    restore();

    expect(registeredTiers().map((entry) => entry.name)).toEqual(['cdn']);
    expect(dependentsOfKind([tag('post', '9')], 'isr-route')).toEqual(['/neighbour']);
    expect(knownTags()).toContain('neighbour');
  });

  test('the revalidator comes back too — the one a test file cannot restore', async () => {
    const revalidated: string[] = [];
    registerRevalidator((path) => {
      revalidated.push(path);
    });
    registerTier(lruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 }));
    registerDependent([tag('post')], { kind: 'isr-route', id: '/neighbour' });

    const restore = isolateRegistries();
    clearRegistries();
    restore();

    // The revalidator has no reader anywhere, so the only proof it is back is that it runs.
    revalidated.length = 0;
    await invalidateTags([tag('post')]);
    expect(revalidated).toEqual(['/neighbour']);
  });
});
