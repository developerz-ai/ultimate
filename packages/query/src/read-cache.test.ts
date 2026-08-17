// Single responsibility: the tier itself — what the default cache retains, what drops it, and
// what `invalidateQueryTags` reaches. The read path's use of it is `cache.test.ts`, and the
// end-to-end pairing (a `cache:` query, an action's `invalidates`, the next request) is
// `read.test.ts`. Here the tier is driven directly, so a failure names the tier and not the read.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { declareTags, isolateDeclaredTags, LruCache, tag } from '@ultimat3/cache';
import { frozenClock } from '@ultimat3/core';
import type { ReadCache, ReadCacheEntry } from './read-cache';
import {
  DEFAULT_READ_CACHE_MAX_BYTES,
  DEFAULT_READ_CACHE_TTL_MS,
  getReadCache,
  invalidateQueryTags,
  MemoryReadCache,
  setReadCache,
} from './read-cache';

const original = getReadCache();
let tier = new MemoryReadCache();

/**
 * The entities this file's tags belong to, declared here rather than inherited. `assertKnownTags`
 * validates nothing while NOTHING has been declared, so these tests used to pass only because no
 * file that ran before them had declared an entity — and failed with X_CACHE_TAG_UNKNOWN the
 * moment one had (`bun test packages/query packages/cli`). Declaring them is also the stricter
 * run: the fan-out below is now checked against a real registry instead of a disabled one.
 */
const restoreTags = isolateDeclaredTags();
declareTags(['post', 'comment']);

beforeEach(() => {
  tier = new MemoryReadCache();
  setReadCache(tier);
});

// The installed tier is process-wide; a leaked one reroutes every later read in this process.
afterAll(() => {
  setReadCache(original);
  restoreTags();
});

describe('the installed tier', () => {
  test('setReadCache swaps what getReadCache answers with', () => {
    expect(getReadCache()).toBe(tier);
    const replacement = new MemoryReadCache();
    setReadCache(replacement);
    expect(getReadCache()).toBe(replacement);
  });
});

describe('invalidateQueryTags', () => {
  // The defect this pins: the entry was written with no tags and the read tier was never
  // reachable from a fan-out, so a cached list survived the write that changed it — for the
  // life of the process when the read declared no `ttlMs`.
  test('drops an entry the installed tier holds under the same tag', async () => {
    await tier.set('list', { value: 'rows', expiresAt: null, tags: [tag('post')] });

    await invalidateQueryTags([tag('post')]);

    expect(await tier.get('list')).toBeUndefined();
  });

  // A row write must bust the lists that held the row — the asymmetry @ultimat3/cache's
  // `tagMatches` defines, reached here rather than re-derived.
  test('a row tag drops an entry cached under the bare collection', async () => {
    await tier.set('list', { value: 'rows', expiresAt: null, tags: [tag('post')] });

    await invalidateQueryTags([tag('post', '1')]);

    expect(await tier.get('list')).toBeUndefined();
  });

  test('leaves an entry cached under a different entity alone', async () => {
    await tier.set('comments', { value: 'rows', expiresAt: null, tags: [tag('comment')] });

    await invalidateQueryTags([tag('post')]);

    expect((await tier.get('comments'))?.value).toBe('rows');
  });

  test('does not throw when the installed tier cannot invalidate by tag', async () => {
    class Untagged implements ReadCache {
      readonly #entries = new Map<string, ReadCacheEntry>();
      async get(key: string): Promise<ReadCacheEntry | undefined> {
        return this.#entries.get(key);
      }
      async set(key: string, entry: ReadCacheEntry): Promise<void> {
        this.#entries.set(key, entry);
      }
      async delete(key: string): Promise<void> {
        this.#entries.delete(key);
      }
    }
    setReadCache(new Untagged());

    expect(await invalidateQueryTags([tag('post')])).toBeUndefined();
  });
});

describe('MemoryReadCache', () => {
  test('drops an entry whose expiry has passed, and keeps one that has not', async () => {
    const memory = new MemoryReadCache();
    // One `now` for the write and for the assertion, and a horizon no test machine crosses: a
    // millisecond ticking between the two would expire the live entry for the clock's reasons.
    const now = Date.now();
    await memory.set('stale', { value: 'rows', expiresAt: now - 1 });
    await memory.set('live', { value: 'rows', expiresAt: now + 60_000 });

    expect(await memory.get('stale')).toBeUndefined();
    expect(await memory.get('live')).toEqual({ value: 'rows', expiresAt: now + 60_000 });
  });

  // The unbounded default: one immortal entry per distinct input, and a paginated read keyed by
  // `{ orgId, cursor }` has as many distinct inputs as the deployment has tenants.
  test('is bounded — the least recently used entry goes when the budget is spent', async () => {
    const memory = new MemoryReadCache({ maxBytes: 512 });
    const filler = 'x'.repeat(100);

    for (let i = 0; i < 20; i += 1) {
      await memory.set(`k${i}`, { value: filler, expiresAt: null });
    }

    expect(await memory.get('k0')).toBeUndefined();
    expect((await memory.get('k19'))?.value).toBe(filler);
  });

  test('skips a value too large for the whole budget rather than failing the read', async () => {
    const memory = new MemoryReadCache({ maxBytes: 64 });

    await memory.set('huge', { value: 'x'.repeat(4096), expiresAt: null });

    expect(await memory.get('huge')).toBeUndefined();
  });

  test('drops every entry carrying an invalidated tag, and nothing else', async () => {
    const memory = new MemoryReadCache();
    await memory.set('a', { value: 1, expiresAt: null, tags: [tag('post')] });
    await memory.set('b', { value: 2, expiresAt: null, tags: [tag('post', '7')] });
    await memory.set('c', { value: 3, expiresAt: null, tags: [tag('comment')] });

    expect(await memory.invalidateTags([tag('post')])).toHaveLength(2);
    expect(await memory.get('a')).toBeUndefined();
    expect(await memory.get('b')).toBeUndefined();
    expect((await memory.get('c'))?.value).toBe(3);
  });

  // `Date.now()` here decided whether an entry was already stale, so a frozen clock could not
  // drive it and a read served under an injected clock was judged against the wall clock.
  test('reads "now" from the injected clock, never the wall clock', async () => {
    const clock = frozenClock(1_000);
    const memory = new MemoryReadCache({ clock });

    await memory.set('stale', { value: 'rows', expiresAt: 999 });
    await memory.set('live', { value: 'rows', expiresAt: 61_000 });

    expect(await memory.get('stale')).toBeUndefined();
    expect((await memory.get('live'))?.value).toBe('rows');
  });

  /**
   * The wiring the boot depends on: `invalidateTags` fans out to registered `CacheTier`s only, so
   * the read cache holds entries in the SAME `LruCache` the process registers as its `lru` tier.
   * Sharing the object is what makes the read tier reachable by the one fan-out.
   */
  test('holds its entries in a caller-supplied LruCache, tag index included', async () => {
    const shared = new LruCache();
    const memory = new MemoryReadCache({ cache: shared });

    await memory.set('a', { value: 1, expiresAt: null, tags: [tag('post')] });

    // Dropped through the tier's own handle on the cache — the half `invalidateTags` reaches.
    expect(shared.invalidateTags([tag('post')])).toEqual(['a']);
    expect(await memory.get('a')).toBeUndefined();
  });

  test('the defaults are the numbers the read path is documented against', () => {
    expect(DEFAULT_READ_CACHE_TTL_MS).toBe(60_000);
    expect(DEFAULT_READ_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
