import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { systemClock, withSpan } from '@ultimat3/core';
import { createCdnTier } from './cdn';
import { CacheDriverUnavailableError, CacheTagUnknownError } from './errors';
import { dependentsOfKind, isolateGraph, registerDependent, resetGraph } from './graph';
import type { InvalidationEvent } from './invalidate';
import {
  invalidateTags,
  invalidateWireTags,
  isolateTiers,
  recentInvalidations,
  registeredTiers,
  registerInvalidationBroadcast,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
import { createLruTier } from './lru';
import type { RedisLike } from './redis';
import { createRedisTier, REDIS_INVALIDATE_SCRIPT, REDIS_TAG_MEMBER_SCRIPT } from './redis';
import { declareTags, isolateDeclaredTags, knownTags, resetDeclaredTags, tag } from './tags';
import { bestEffort, recentTierFailures } from './tier-failures';
import type { CacheTier, TierInvalidation } from './tiers';

/**
 * A recorder, never a Lua interpreter. It used to mirror both script bodies in TypeScript, which
 * is why gutting either one left every test here green — the fan-out was asserting against the
 * mirror. `answerEval` is how a test states what the server's script returned; an unprogrammed
 * `EVAL` throws, which `bestEffort` turns into a `report.errors` entry rather than a silent
 * empty bust. `redis.live.test.ts` owns the scripts' own semantics.
 */
function fakeRedis(): RedisLike & {
  readonly sent: string[][];
  answerEval(script: string, reply: unknown): void;
} {
  const values = new Map<string, string>();
  const sent: string[][] = [];
  // Nothing reads the tag-join's reply, so a constant asserts nothing about that script.
  const evalReplies = new Map<string, unknown>([[REDIS_TAG_MEMBER_SCRIPT, 1]]);
  return {
    sent,
    answerEval(script, reply) {
      evalReplies.set(script, reply);
    },
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
      if (command === 'DEL') {
        values.delete(String(args[0]));
        return Promise.resolve(1);
      }
      if (command === 'EVAL') {
        const script = String(args[0]);
        if (!evalReplies.has(script)) {
          throw new Error(
            'fake redis cannot execute EVAL — call answerEval(script, reply) to state what the ' +
              'server returned, or move the claim to redis.live.test.ts, which runs the script',
          );
        }
        return Promise.resolve(evalReplies.get(script));
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
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    // `buildId: null` so the canned member below can name the value key without reading
    // `appVersion()`; the namespace is `redis.test.ts`'s subject, not this file's.
    const client = fakeRedis();
    const redis = createRedisTier({ client, buildId: null });
    const cdn = cdnSpy();
    // Registered out of order on purpose: the stack must normalise to TIER_ORDER.
    registerTier(cdn);
    registerTier(redis);
    registerTier(lru);

    await lru.set('feed', ['a'], { tags: [tag('post')] });
    await redis.set('feed', ['a'], { tags: [tag('post')] });
    await lru.set('users', ['u'], { tags: [tag('user')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, ['x:c:feed']);

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
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
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

describe('recentInvalidations log', () => {
  test('an invalidation is recorded with its wire tags, its duration and the keys every tier reported', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });

    const report = await invalidateTags([tag('post')]);

    const [event] = recentInvalidations();
    expect(event?.tags).toEqual(report.tags);
    expect(event?.durationMs).toBe(report.durationMs);
    expect(event?.busted).toContain('feed');
  });

  test('busted includes ISR paths, live queries and what the CDN tier actually purged, with no duplicates', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    const purged: string[] = [];
    registerTier(lru);
    registerTier(
      createCdnTier({
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
    expect(purged).toEqual(['post', '/feed.xml']);
    const [event] = recentInvalidations();
    expect(event?.busted).toEqual(['post', '/feed.xml', '/blog', 'live:post-list']);
  });

  test('with no CDN tier registered, a cdn-path is a dependent and never a bust', async () => {
    // `report.cdn` came from the graph and was folded into `busted` whether or not anything
    // purged it, so `x cache bust --json` named `/blog/hello` cleared while the edge held it
    // for its whole s-maxage. A partial bust that reads as a clean one is the failure the log
    // exists to catch.
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    registerDependent([tag('post', '1')], { kind: 'cdn-path', id: '/blog/hello' });

    const report = await invalidateTags([tag('post', '1')]);

    expect(report.cdn).toEqual(['/blog/hello']);
    const [event] = recentInvalidations();
    expect(event?.busted).not.toContain('/blog/hello');
  });

  test('newest first, and the log never grows past the cap (drive it past 100)', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
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
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);

    await withSpan('job.reindex', () => invalidateTags([tag('post')]));

    const [event] = recentInvalidations();
    expect(event?.source).toBe('job.reindex');
  });

  test('source falls back to the literal invalidateTags when there is no active span', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
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
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
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
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await invalidateTags([tag('post')]);
    expect(recentInvalidations().length).toBe(1);

    resetTiers();

    expect(recentInvalidations()).toEqual([]);
  });

  test('invalidateWireTags records exactly one event, not two', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);

    await invalidateWireTags(['post']);

    expect(recentInvalidations().length).toBe(1);
  });

  test('at is an ISO-8601 timestamp from the frozen system clock', async () => {
    const lru = createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    const before = systemClock.now().toISOString();

    await invalidateTags([tag('post')]);

    const [event] = recentInvalidations();
    expect(event?.at).toBe(before);
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

  test('the revalidator and both logs come back too — the three a test file cannot restore', async () => {
    const revalidated: string[] = [];
    registerRevalidator((path) => {
      revalidated.push(path);
    });
    registerTier(createLruTier({ maxBytes: 1_000, defaultTtlMs: 3_600_000 }));
    registerDependent([tag('post')], { kind: 'isr-route', id: '/neighbour' });
    await invalidateTags([tag('post')]);
    await bestEffort('redis', 'get', 'k', () => Promise.reject(new Error('neighbour boom')));

    const restore = isolateRegistries();
    clearRegistries();
    // `resetTiers()` really did drop all three, so the restore below is doing the work.
    expect(recentInvalidations()).toEqual([]);
    expect(recentTierFailures()).toEqual([]);
    restore();

    expect(recentInvalidations().map((event) => event.tags)).toEqual([['post']]);
    expect(recentTierFailures()[0]?.message).toBe('Error: neighbour boom');

    // The revalidator has no reader anywhere, so the only proof it is back is that it runs.
    revalidated.length = 0;
    await invalidateTags([tag('post')]);
    expect(revalidated).toEqual(['/neighbour']);
  });
});
