// The stampede guard's own suite: what a joiner that shares an in-flight `load()` contributes to
// the write it also shares. Kept apart from `tiers.test.ts` because the ladder's order, expiry and
// write-back are answerable from one caller, and every question here needs two — a leader and a
// joiner interleaved at a named await.

import { describe, expect, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import { tag } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier } from './tiers';
import { createCacheStack, DEFAULT_LOAD_DEADLINE_MS } from './tiers';

/**
 * A tier that keeps the tags it was written with and evicts on them. `tiers.test.ts`'s `fakeTier`
 * answers `invalidateTags` with an empty key list, which is exactly the half this suite observes,
 * so the fixture is this file's own rather than a shared one widened for one caller.
 */
function taggingTier(name: CacheTier['name']): CacheTier & {
  readonly entries: Map<string, CacheEntry<unknown>>;
  onSet?: ((key: string, options?: CacheSetOptions) => Promise<void>) | undefined;
} {
  const entries = new Map<string, CacheEntry<unknown>>();
  const tier = {
    name,
    entries,
    onSet: undefined as ((key: string, options?: CacheSetOptions) => Promise<void>) | undefined,
    get<T>(key: string) {
      return Promise.resolve(entries.get(key) as CacheEntry<T> | undefined);
    },
    async set<T>(key: string, value: T, options?: CacheSetOptions) {
      await tier.onSet?.(key, options);
      entries.set(key, { value, tags: options?.tags ?? [] });
    },
    del(key: string) {
      entries.delete(key);
      return Promise.resolve();
    },
    invalidateTags(tags: readonly ReturnType<typeof tag>[]) {
      const wanted = new Set(
        tags.map((t) => (t.id === undefined ? t.entity : `${t.entity}:${t.id}`)),
      );
      const keys: string[] = [];
      for (const [key, entry] of entries) {
        const hit = entry.tags.some((t) =>
          wanted.has(t.id === undefined ? t.entity : `${t.entity}:${t.id}`),
        );
        if (!hit) continue;
        keys.push(key);
        entries.delete(key);
      }
      return Promise.resolve({ tier: name, keys });
    },
  };
  return tier;
}

describe('a single-flight joiner that arrives during the FILL', () => {
  test('gets its tag onto the entry that lands, on every tier', async () => {
    // The leader reads the merged context ONCE, before the ladder it then walks one await per
    // rung — so a joiner that merges `feed` while the fill is in flight shares the leader's
    // value, shares the leader's write, and the entry lands under the leader's tags alone.
    // `invalidateTags(['feed'])` then never reaches it, and the joiner's own invalidation — the
    // entire reason for declaring a tag — is silently a no-op for the whole TTL.
    const tier = taggingTier('lru');
    const stack = createCacheStack([tier]);
    const writes: string[][] = [];
    let joiner: Promise<string> | undefined;

    tier.onSet = async (key, options) => {
      writes.push((options?.tags ?? []).map((t) => t.entity));
      if (joiner !== undefined) return;
      joiner = stack.read(key, () => Promise.resolve('joined'), { tags: [tag('feed')] });
      // A macrotask: the joiner's own lookup is a chain of microtasks, so yielding here lands
      // after it has reached `flight.run` and merged — and before this write completes.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    };

    const leader = await stack.read('k', () => Promise.resolve('led'), { tags: [tag('post')] });
    expect(leader).toBe('led');
    expect(await joiner).toBe('led');

    expect(
      tier.entries
        .get('k')
        ?.tags.map((t) => t.entity)
        .sort(),
    ).toEqual(['feed', 'post']);
    expect(writes[0]).toEqual(['post']);

    const invalidated = await tier.invalidateTags([tag('feed')]);
    expect(invalidated.keys).toEqual(['k']);
    expect(await tier.get('k')).toBeUndefined();
  });
});

// A `load()` that never settles used to hold its key for the life of the process, and every later
// reader joined a promise nothing would resolve — a cache turned from an outage damper into the
// outage. `load()` is the APP's function and the stack has no signal to abort it, so the deadline
// evicts the KEY and nothing else: the wedged load keeps running, its own readers keep their
// promise, and the next reader gets to try. The cost is one duplicate fill, never a failed read.
describe('a wedged load does not hold its key for ever', () => {
  interface Timer {
    readonly schedule: Scheduler;
    /** The delay the stack asked for, or `undefined` if it scheduled nothing. */
    readonly ms: number | undefined;
    fire(): void;
  }

  const controlledTimer = (): Timer => {
    let ms: number | undefined;
    let pending = (): void => {};
    return {
      schedule: (fn, delay) => {
        ms = delay;
        pending = fn;
        return (): void => {
          pending = (): void => {};
        };
      },
      get ms(): number | undefined {
        return ms;
      },
      fire(): void {
        pending();
      },
    };
  };

  /** A macrotask turn: long enough for every queued continuation to have run. */
  const flush = async (): Promise<void> => {
    await new Promise<void>((done) => {
      setTimeout(done, 0);
    });
  };

  test('the default deadline is the one an abandoned request already gave up at', async () => {
    const timer = controlledTimer();
    const stack = createCacheStack([taggingTier('lru')], { schedule: timer.schedule });
    void stack.read('feed', () => new Promise<string>(() => {}));
    // `read` walks the ladder before it ever reaches the flight, so the timer is armed an await
    // later than the call.
    await flush();
    expect(timer.ms).toBe(DEFAULT_LOAD_DEADLINE_MS);
    // Stated as a literal too: `@ultimat3/http`'s `requestTimeoutMs` defaults to the same 30s and
    // cache (tier 1) may not import http (tier 2) to read it, so this is the only place the two
    // can be seen to agree.
    expect(DEFAULT_LOAD_DEADLINE_MS).toBe(30_000);
  });

  test('loadDeadlineMs overrides it without a new config key', async () => {
    const timer = controlledTimer();
    const stack = createCacheStack([taggingTier('lru')], {
      schedule: timer.schedule,
      loadDeadlineMs: 2_500,
    });
    void stack.read('feed', () => new Promise<string>(() => {}));
    await flush();
    expect(timer.ms).toBe(2_500);
  });

  test('past the deadline the key is free, so the next reader loads instead of joining', async () => {
    const timer = controlledTimer();
    const stack = createCacheStack([taggingTier('lru')], { schedule: timer.schedule });
    let loads = 0;
    const wedged = (): Promise<string> => {
      loads += 1;
      return new Promise<string>(() => {});
    };

    void stack.read('feed', wedged);
    void stack.read('feed', wedged);
    await flush();
    // Both joined one load: that is the stampede guard doing its job.
    expect(loads).toBe(1);

    timer.fire();
    // Observed through a flush rather than an await, deliberately: with the key still held this
    // read JOINS the wedged load and never settles, and awaiting it would report the defect as a
    // five-second timeout instead of as the reader that never got its own turn.
    let answered: string | undefined;
    void stack
      .read('feed', async () => 'fresh')
      .then((value) => {
        answered = value;
      });
    await flush();
    expect(answered).toBe('fresh');
    // The wedged load was never re-run — eviction frees the key, it does not retry the work.
    expect(loads).toBe(1);
  });
});
