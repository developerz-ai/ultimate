// Every test here is a RACE, and none of them sleeps: a deferred promise is what puts one
// operation provably inside another's window. The two failures pinned are the ones a report of
// `errors: []` cannot see — a fill that lands after the bust it should have obeyed, and a read
// that promotes a not-yet-cleared far tier back into an already-cleared near one.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { invalidateTags, isolateTiers, registerTier, resetTiers } from './invalidate';
import { createLruTier } from './lru';
import { declareTags, isolateDeclaredTags, tag } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier, TierInvalidation, TierName } from './tiers';
import { createCacheStack } from './tiers';

const restoreTiers = isolateTiers();
const restoreTags = isolateDeclaredTags();
// Declared rather than left off: a neighbouring file in the same `bun test` process may have
// switched validation on, and these tags must be legal either way.
declareTags(['post', 'user']);
afterAll(() => {
  restoreTiers();
  restoreTags();
});

beforeEach(() => {
  resetTiers();
});

/** A promise a test resolves by hand — the only ordering primitive this file is allowed. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Records the order tiers are asked to invalidate in. */
function recordingTier(name: TierName, order: TierName[]): CacheTier {
  return {
    name,
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    del: () => Promise.resolve(),
    invalidateTags(): Promise<TierInvalidation> {
      order.push(name);
      return Promise.resolve({ tier: name, keys: [] });
    },
  };
}

/** A far tier holding a stale value, whose own bust a test can hold open. */
function gatedFarTier(value: string): CacheTier & { entered: Promise<void>; release(): void } {
  const store = new Map<string, CacheEntry<unknown>>();
  store.set('post:1', { value, tags: [tag('post', '1')] });
  const entered = deferred<void>();
  const gate = deferred<void>();
  return {
    name: 'redis',
    entered: entered.promise,
    release: () => {
      gate.resolve();
    },
    get<T>(key: string) {
      return Promise.resolve(store.get(key) as CacheEntry<T> | undefined);
    },
    set<T>(key: string, next: T, options?: CacheSetOptions) {
      store.set(key, { value: next, tags: options?.tags ?? [] });
      return Promise.resolve();
    },
    del(key: string) {
      store.delete(key);
      return Promise.resolve();
    },
    async invalidateTags(): Promise<TierInvalidation> {
      entered.resolve();
      await gate.promise;
      const keys = [...store.keys()];
      store.clear();
      return { tier: 'redis', keys };
    },
  };
}

describe('a fill that outlives the invalidation it raced', () => {
  test('an invalidation landing during an in-flight load is NOT overwritten by the fill', async () => {
    // T0 miss -> load(); T1 the mutator commits and busts a key that is not there yet, a no-op;
    // T2 load() resolves with rows read BEFORE that write; T3 the fill writes them for the full
    // TTL. The write is invisible to every reader for `ttlMs` and the report says `errors: []`.
    const lru = createLruTier({ rng: () => 0 });
    registerTier(lru);
    const stack = createCacheStack([lru]);

    const started = deferred<void>();
    const gate = deferred<string>();
    const read = stack.read(
      'post:1',
      () => {
        started.resolve();
        return gate.promise;
      },
      { ttlMs: 60_000, tags: [tag('post', '1')] },
    );

    await started.promise;
    const report = await invalidateTags([tag('post', '1')]);
    expect(report.errors).toEqual([]);

    gate.resolve('rows-read-before-the-write');

    // The caller still gets what the origin answered — a fence never fails a business read.
    expect(await read).toBe('rows-read-before-the-write');
    expect(lru.cache.get('post:1')).toBeUndefined();
  });

  test('a stack.drop during an in-flight load is not overwritten either', async () => {
    const lru = createLruTier({ rng: () => 0 });
    const stack = createCacheStack([lru]);

    const started = deferred<void>();
    const gate = deferred<string>();
    const read = stack.read(
      'post:1',
      () => {
        started.resolve();
        return gate.promise;
      },
      { ttlMs: 60_000, tags: [tag('post', '1')] },
    );

    await started.promise;
    await stack.drop('post:1');
    gate.resolve('stale');

    expect(await read).toBe('stale');
    expect(lru.cache.get('post:1')).toBeUndefined();
  });

  test('a write() landing during an in-flight load wins over the fill', async () => {
    const lru = createLruTier({ rng: () => 0 });
    const stack = createCacheStack([lru]);

    const started = deferred<void>();
    const gate = deferred<string>();
    const read = stack.read(
      'post:1',
      () => {
        started.resolve();
        return gate.promise;
      },
      { ttlMs: 60_000, tags: [tag('post', '1')] },
    );

    await started.promise;
    await stack.write('post:1', 'written-after-the-load-began', { ttlMs: 60_000 });
    gate.resolve('stale');
    await read;

    expect(lru.cache.get<string>('post:1')?.value).toBe('written-after-the-load-began');
  });

  test('nothing racing it: an ordinary fill still lands in every tier', async () => {
    // The mutation that would otherwise make every test above pass for free — a fence that
    // refuses every write is not a fence.
    const lru = createLruTier({ rng: () => 0 });
    const stack = createCacheStack([lru]);

    expect(await stack.read('post:1', () => Promise.resolve('fresh'), { ttlMs: 60_000 })).toBe(
      'fresh',
    );
    expect(lru.cache.get<string>('post:1')?.value).toBe('fresh');
  });
});

describe('the fan-out clears farthest-first', () => {
  test('tiers are invalidated in reverse read order', async () => {
    const order: TierName[] = [];
    registerTier(recordingTier('lru', order));
    registerTier(recordingTier('redis', order));
    registerTier(recordingTier('request-memo', order));

    const report = await invalidateTags([tag('post')]);

    expect(order).toEqual(['redis', 'lru', 'request-memo']);
    // The REPORT stays in read order: it is what the `/_x` panel renders, and a ladder printed
    // upside down is a second thing to learn.
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['request-memo', 'lru', 'redis']);
  });

  test('a read racing the bust cannot promote a stale value into a cleared near tier', async () => {
    const lru = createLruTier({ rng: () => 0 });
    const far = gatedFarTier('STALE');
    registerTier(lru);
    registerTier(far);
    const stack = createCacheStack([lru, far]);

    const bust = invalidateTags([tag('post', '1')]);
    await far.entered;

    // The far tier has not cleared yet, so this read finds STALE there and promotes it up.
    await stack.read('post:1', () => Promise.resolve('FRESH'), {
      ttlMs: 60_000,
      tags: [tag('post', '1')],
    });

    far.release();
    await bust;

    expect(lru.cache.get('post:1')).toBeUndefined();
  });
});
