// This cache decides when two prompts are "the same question", which makes its threshold a
// correctness boundary rather than a tuning knob: set slightly too loose, it hands a user the
// answer to somebody else's question. The maths, that boundary and expiry are pinned here.

import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { cosineSimilarity, createMemorySemanticCache } from './semantic';
import { tag } from './tags';

/** Manual clock: TTL tests must not depend on wall time. */
function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

describe('cosineSimilarity', () => {
  test('identical vectors are similarity 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  test('orthogonal vectors are similarity 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test('opposite vectors are similarity -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  test('mismatched lengths are 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  test('an all-zero vector is 0', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  test('empty arrays are 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('createMemorySemanticCache defaults', () => {
  test('name is "memory"', () => {
    expect(createMemorySemanticCache().name).toBe('memory');
  });
});

describe('remember + lookup', () => {
  test('a near-identical embedding above the default threshold hits', async () => {
    const cache = createMemorySemanticCache();
    await cache.remember('k', [1, 0, 0], 'value');

    const hit = await cache.lookup<string>([1, 0, 0]);

    expect(hit).toBeDefined();
    expect(hit?.value).toBe('value');
    expect(hit?.key).toBe('k');
    expect(hit?.similarity).toBeCloseTo(1);
  });

  test('an embedding below the default threshold misses', async () => {
    const cache = createMemorySemanticCache();
    await cache.remember('k', [1, 0], 'value');

    // Orthogonal: similarity 0, far below 0.92.
    const hit = await cache.lookup<string>([0, 1]);

    expect(hit).toBeUndefined();
  });

  test('an override threshold can surface a hit the default would miss', async () => {
    const cache = createMemorySemanticCache();
    await cache.remember('k', [1, 1], 'value');

    // [1, 1] vs [1, 0.3] has similarity ~0.88: below the default 0.92 but above a relaxed 0.8.
    const belowDefault = [1, 0.3];
    expect(await cache.lookup<string>(belowDefault)).toBeUndefined();
    const hit = await cache.lookup<string>(belowDefault, 0.8);
    expect(hit?.value).toBe('value');
  });

  test('an override threshold can suppress a hit the default would surface', async () => {
    const cache = createMemorySemanticCache();
    await cache.remember('k', [1, 0, 0], 'value');

    const hit = await cache.lookup<string>([1, 0, 0], 0.999999);
    expect(hit?.value).toBe('value');

    const suppressed = await cache.lookup<string>([0.95, 0.05, 0], 0.999999);
    expect(suppressed).toBeUndefined();
  });

  test('lookup returns the best match among multiple candidates', async () => {
    const cache = createMemorySemanticCache();
    await cache.remember('far', [1, 0.3], 'far-value');
    await cache.remember('close', [1, 0.02], 'close-value');

    const hit = await cache.lookup<string>([1, 0]);

    expect(hit?.key).toBe('close');
    expect(hit?.value).toBe('close-value');
  });

  test('re-remembering the same key replaces rather than duplicates', async () => {
    const cache = createMemorySemanticCache();
    await cache.remember('k', [1, 0], 'first');
    await cache.remember('k', [0, 1], 'second');

    expect(await cache.size()).toBe(1);

    // Only the new embedding should hit now.
    const oldHit = await cache.lookup<string>([1, 0]);
    expect(oldHit).toBeUndefined();

    const newHit = await cache.lookup<string>([0, 1]);
    expect(newHit?.value).toBe('second');
    expect(newHit?.key).toBe('k');
  });
});

describe('maxEntries eviction', () => {
  test('evicts the oldest-inserted key by insertion order, not access order', async () => {
    const cache = createMemorySemanticCache({ maxEntries: 2 });

    await cache.remember('a', [1, 0, 0], 'a-value');
    await cache.remember('b', [0, 1, 0], 'b-value');
    // Access 'a' — semantic.ts has no touch-on-lookup, so this must not save it from eviction.
    await cache.lookup<string>([1, 0, 0]);
    await cache.remember('c', [0, 0, 1], 'c-value');

    expect(await cache.size()).toBeLessThanOrEqual(2);

    const aHit = await cache.lookup<string>([1, 0, 0]);
    expect(aHit).toBeUndefined();

    const bHit = await cache.lookup<string>([0, 1, 0]);
    expect(bHit?.value).toBe('b-value');

    const cHit = await cache.lookup<string>([0, 0, 1]);
    expect(cHit?.value).toBe('c-value');
  });
});

describe('TTL expiry', () => {
  test('an entry with an explicit ttlMs expires on the injected clock', async () => {
    const clock = fakeClock(1_000_000);
    const cache = createMemorySemanticCache({ clock });

    await cache.remember('k', [1, 0], 'v', { ttlMs: 1_000 });

    expect(await cache.lookup<string>([1, 0])).toBeDefined();

    clock.advance(1_001);

    expect(await cache.lookup<string>([1, 0])).toBeUndefined();
    expect(await cache.size()).toBe(0);
  });

  test('a ttlMs that is not a positive, finite number is refused, never stored expired', async () => {
    // The rule every tier writes under, applied to the one cache that was skipping it: `0` stored
    // an entry already past its expiry, so every lookup missed and the only evidence was a
    // completion bill. `X_CACHE_TTL_INVALID` names the edit instead.
    const cache = createMemorySemanticCache({ clock: fakeClock(1_000) });

    // Thrown where it is validated, exactly as `LruCache.set` throws X_CACHE_TOO_LARGE: the
    // caller's `await` sees a rejection either way, and `bestEffort` absorbs both shapes.
    expect(() => cache.remember('k', [1, 0], 'v', { ttlMs: 0 })).toThrow('X_CACHE_TTL_INVALID');
    expect(() => cache.remember('k', [1, 0], 'v', { ttlMs: Number.POSITIVE_INFINITY })).toThrow(
      'X_CACHE_TTL_INVALID',
    );
    expect(await cache.size()).toBe(0);
  });

  test('defaultTtlMs applies when remember is called without an explicit ttlMs', async () => {
    const clock = fakeClock(1_000_000);
    const cache = createMemorySemanticCache({ defaultTtlMs: 500, clock });

    await cache.remember('k', [1, 0], 'v');

    clock.advance(499);
    expect(await cache.lookup<string>([1, 0])).toBeDefined();

    clock.advance(2);
    expect(await cache.lookup<string>([1, 0])).toBeUndefined();
    expect(await cache.size()).toBe(0);
  });
});

describe('invalidateTags', () => {
  test('removes only entries whose tags intersect the requested tags', async () => {
    const cache = createMemorySemanticCache();

    await cache.remember('post:1', [1, 0, 0], 'p1', { tags: [tag('post', '1')] });
    await cache.remember('post:2', [0, 1, 0], 'p2', { tags: [tag('post', '2')] });
    await cache.remember('user:1', [0, 0, 1], 'u1', { tags: [tag('user', '1')] });

    const removed = await cache.invalidateTags([tag('post', '1')]);

    expect(removed).toEqual(['post:1']);
    expect(await cache.size()).toBe(2);
    expect(await cache.lookup<string>([1, 0, 0])).toBeUndefined();
    expect((await cache.lookup<string>([0, 1, 0]))?.value).toBe('p2');
    expect((await cache.lookup<string>([0, 0, 1]))?.value).toBe('u1');
  });

  test('a collection tag sweeps every row of that entity', async () => {
    const cache = createMemorySemanticCache();

    await cache.remember('post:1', [1, 0, 0], 'p1', { tags: [tag('post', '1')] });
    await cache.remember('post:2', [0, 1, 0], 'p2', { tags: [tag('post', '2')] });
    await cache.remember('user:1', [0, 0, 1], 'u1', { tags: [tag('user', '1')] });

    const removed = await cache.invalidateTags([tag('post')]);

    expect([...removed].sort()).toEqual(['post:1', 'post:2']);
    expect(await cache.size()).toBe(1);
    expect((await cache.lookup<string>([0, 0, 1]))?.value).toBe('u1');
  });
});

describe('size', () => {
  test('reflects live entry count and matches eager-expiry behavior', async () => {
    const clock = fakeClock(0);
    const cache = createMemorySemanticCache({ clock });

    expect(await cache.size()).toBe(0);

    await cache.remember('a', [1, 0], 'a-value', { ttlMs: 100 });
    await cache.remember('b', [0, 1], 'b-value', { ttlMs: 1_000 });
    expect(await cache.size()).toBe(2);

    clock.advance(101);
    expect(await cache.size()).toBe(1);
  });
});

/**
 * The file header calls the threshold "a correctness boundary rather than a tuning knob: set
 * slightly too loose, it hands a user the answer to somebody else's question". `NaN` is not
 * slightly too loose — it removes the boundary: `similarity < NaN` is false for every record, so
 * `lookup` answers the closest thing it holds whatever the question was. `maxEntries: NaN` is the
 * same shape one line down (`records.size > NaN` never evicts), and both arrive the same way —
 * `Number(process.env.SEMANTIC_THRESHOLD)` on an unset variable.
 */
describe('the semantic cache refuses a limit that is not a limit', () => {
  test('a NaN threshold is refused, never a cache that matches everything', () => {
    expect(() => createMemorySemanticCache({ threshold: Number.NaN })).toThrow(
      /X_CACHE_LIMIT_INVALID/,
    );
  });

  test('a threshold outside [0, 1] is refused — cosine similarity has no values there', () => {
    expect(() => createMemorySemanticCache({ threshold: 1.5 })).toThrow(/X_CACHE_LIMIT_INVALID/);
    expect(() => createMemorySemanticCache({ threshold: -0.5 })).toThrow(/X_CACHE_LIMIT_INVALID/);
    expect(() => createMemorySemanticCache({ threshold: 0 })).not.toThrow();
    expect(() => createMemorySemanticCache({ threshold: 1 })).not.toThrow();
  });

  test('a NaN maxEntries is refused, never a table that never evicts', () => {
    expect(() => createMemorySemanticCache({ maxEntries: Number.NaN })).toThrow(
      /X_CACHE_LIMIT_INVALID/,
    );
    expect(() => createMemorySemanticCache({ maxEntries: 0 })).toThrow(/X_CACHE_LIMIT_INVALID/);
  });

  test('a per-call threshold override is screened too — it is the same boundary', async () => {
    const cache = createMemorySemanticCache({ clock: fakeClock(0) });
    await cache.remember('a', [1, 0], 'answer for a');
    // Without the screen this answered `'answer for a'` for a vector orthogonal to it. Thrown
    // where it is validated, exactly as `remember` throws `X_CACHE_TTL_INVALID` above: the
    // caller's `await` sees it either way.
    expect(() => cache.lookup([0, 1], Number.NaN)).toThrow(/X_CACHE_LIMIT_INVALID/);
  });

  test('an ordinary configuration still builds and still gates', async () => {
    const cache = createMemorySemanticCache({ threshold: 0.9, maxEntries: 2, clock: fakeClock(0) });
    await cache.remember('a', [1, 0], 'answer for a');
    expect(await cache.lookup([0, 1])).toBeUndefined();
    expect(await cache.lookup([1, 0])).toMatchObject({ value: 'answer for a' });
  });
});
