// A read after a bust must see the bust. The fence stops a stale load's fill; these pin that it also
// stops the join, by key and by tag, including while the overtaken load is settling.

import { describe, expect, spyOn, test } from 'bun:test';
import * as fenceModule from './fence';
import { markInvalidated } from './fence';
import { isolateGraph } from './graph';
import { invalidateTags } from './invalidate';
import { tag } from './tags';
import * as leadingModule from './tier-leading';
import type { CacheEntry, CacheSetOptions, CacheTier } from './tiers';
import { cacheStack } from './tiers';

/** Minimal, in-memory `CacheTier` that records every call it receives. */
function fakeTier(name: CacheTier['name'], calls: string[]): CacheTier {
  const store = new Map<string, CacheEntry<unknown>>();
  return {
    name,
    get<T>(key: string) {
      calls.push(`get:${name}:${key}`);
      return Promise.resolve(store.get(key) as CacheEntry<T> | undefined);
    },
    set<T>(key: string, value: T, options?: CacheSetOptions) {
      calls.push(`set:${name}:${key}`);
      store.set(key, { value, tags: options?.tags ?? [] });
      return Promise.resolve();
    },
    del(key: string) {
      calls.push(`del:${name}:${key}`);
      store.delete(key);
      return Promise.resolve();
    },
    invalidateTags() {
      return Promise.resolve({ tier: name, keys: [] });
    },
  };
}

/** A promise a test resolves by hand, so several callers are provably in flight at once. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The fence stops a stale load's FILL. It did not stop a read after the bust joining that load, so
 * a read-your-write saw pre-write data for up to the load's life: `drop` then read answered `old`.
 */
describe('a read after a bust does not join the load the bust overtook', () => {
  const held = (calls: string[]) => {
    const old = deferred<string>();
    const stack = cacheStack([fakeTier('lru', calls)]);
    return { old, stack };
  };
  /** Lets a read walk its ladder and reach the flight. */
  const reachFlight = (): Promise<void> => Bun.sleep(0);

  test('by key: `drop` during a load, and the next read is a fresh load', async () => {
    const { old, stack } = held([]);
    let loads = 0;
    const leader = stack.read('k3:key', () => {
      loads += 1;
      return old.promise;
    });
    await reachFlight();
    await stack.drop('k3:key');
    const after = stack.read('k3:key', async () => {
      loads += 1;
      return 'new';
    });
    expect(await after).toBe('new');
    old.resolve('old');
    expect(await leader).toBe('old');
    expect(loads).toBe(2);
    // The overtaken load is refused its fill; the ladder keeps what the fresh load wrote.
    expect(await stack.read('k3:key', async () => 'never')).toBe('new');
  });

  test('by tag: a bust names no key, and still overtakes the load', async () => {
    const restore = isolateGraph();
    try {
      const { old, stack } = held([]);
      const leader = stack.read('k3:tag', () => old.promise, { tags: [tag('k3feed')] });
      await reachFlight();
      await invalidateTags([tag('k3feed')]);
      const after = stack.read('k3:tag', async () => 'new', { tags: [tag('k3feed')] });
      expect(await after).toBe('new');
      old.resolve('old');
      expect(await leader).toBe('old');
    } finally {
      restore();
    }
  });

  test('a bust of a tag only this reader declares overtakes it too', async () => {
    const { old, stack } = held([]);
    const leader = stack.read('k3:own-tag', () => old.promise);
    await reachFlight();
    markInvalidated({ tags: [tag('k3own')] });
    const after = stack.read('k3:own-tag', async () => 'new', { tags: [tag('k3own')] });
    expect(await after).toBe('new');
    old.resolve('old');
    await leader;
  });

  test('a joiner from before the bust still shares the load it joined', async () => {
    const { old, stack } = held([]);
    let loads = 0;
    const load = (): Promise<string> => {
      loads += 1;
      return old.promise;
    };
    const leader = stack.read('k3:before', load);
    await reachFlight();
    const joiner = stack.read('k3:before', load);
    await reachFlight();
    await stack.drop('k3:before');
    old.resolve('old');
    expect(await Promise.all([leader, joiner])).toEqual(['old', 'old']);
    expect(loads).toBe(1);
  });

  test('no fence moved, one load', async () => {
    const { old, stack } = held([]);
    let loads = 0;
    const load = (): Promise<string> => {
      loads += 1;
      return old.promise;
    };
    const readers = [stack.read('k3:quiet', load)];
    await reachFlight();
    // Another key's bust, and a tag nobody here carries, are not this load's business.
    await stack.drop('k3:other');
    markInvalidated({ tags: [tag('k3unrelated')] });
    readers.push(stack.read('k3:quiet', load));
    await reachFlight();
    old.resolve('value');
    expect(await Promise.all(readers)).toEqual(['value', 'value']);
    expect(loads).toBe(1);
  });

  // `leading` empties in `work`'s finally, a few microtasks before the flight frees the key, and a
  // read landing there finds no fence and a held key. Where it lands is microtask arithmetic, so the
  // reader's arrival is walked across the whole settle rather than aimed at one tick.
  test('a read landing as an overtaken load settles still runs its own load', async () => {
    for (let ticks = 0; ticks < 40; ticks += 1) {
      const key = `k3:settling:${ticks}`;
      const old = deferred<string>();
      const setHeld = deferred<void>();
      const getHeld = deferred<void>();
      let gets = 0;
      let setEntered = (): void => undefined;
      const entered = new Promise<void>((resolve) => {
        setEntered = resolve;
      });
      const stack = cacheStack([
        {
          name: 'lru',
          async get<T>(): Promise<CacheEntry<T> | undefined> {
            gets += 1;
            // The leader's own walk answers at once; the second reader's is what the test aims.
            if (gets > 1) await getHeld.promise;
            return undefined;
          },
          async set(): Promise<void> {
            setEntered();
            await setHeld.promise;
          },
          async del(): Promise<void> {},
          async invalidateTags() {
            return { tier: 'lru' as const, keys: [] };
          },
        },
      ]);

      const leader = stack.read(key, () => old.promise);
      await reachFlight();
      const reader = stack.read(key, async () => 'new');
      old.resolve('old');
      await entered;
      // The bust lands during the overtaken load's fill, so its fence is invalid at the finally.
      await stack.drop(key);
      setHeld.resolve();
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      getHeld.resolve();

      expect(await reader).toBe('new');
      expect(await leader).toBe('old');
    }
  });

  test('load resolves, then `await drop`, then a read: the read never answers `old`', async () => {
    for (let ticks = 0; ticks < 40; ticks += 1) {
      const key = `k3:after-load:${ticks}`;
      const old = deferred<string>();
      const stack = cacheStack([fakeTier('lru', [])]);
      const leader = stack.read(key, () => old.promise);
      await reachFlight();
      old.resolve('old');
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      await stack.drop(key);
      expect(await stack.read(key, async () => 'new')).toBe('new');
      await leader;
    }
  });

  // The tightest case: no tier to await, so `drop` and the read both fit inside the settle, and the
  // fence is still valid when the load's own work returns.
  test('a bust and a read both landing inside the settle, on an empty ladder', async () => {
    for (let ticks = 0; ticks < 40; ticks += 1) {
      const key = `k3:inside:${ticks}`;
      const old = deferred<string>();
      const stack = cacheStack([]);
      const leader = stack.read(key, () => old.promise);
      await reachFlight();
      old.resolve('old');
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      await stack.drop(key);
      expect(await stack.read(key, async () => 'new')).toBe('new');
      await leader;
    }
  });

  test('the overtaken load settling leaves the load that replaced it joinable', async () => {
    const { old, stack } = held([]);
    const fresh = deferred<string>();
    let loads = 0;
    const load = (): Promise<string> => {
      loads += 1;
      return fresh.promise;
    };
    const leader = stack.read('k3:joinable', () => old.promise);
    await reachFlight();
    await stack.drop('k3:joinable');
    const replacing = stack.read('k3:joinable', load);
    await reachFlight();
    old.resolve('old');
    await leader;
    const joiner = stack.read('k3:joinable', load);
    await reachFlight();
    fresh.resolve('fresh');
    expect(await Promise.all([replacing, joiner])).toEqual(['fresh', 'fresh']);
    expect(loads).toBe(1);
  });

  test('the overtaken load finishing does not free the key from the load that replaced it', async () => {
    const { old, stack } = held([]);
    const fresh = deferred<string>();
    let loads = 0;
    const leader = stack.read('k3:identity', () => old.promise);
    await reachFlight();
    await stack.drop('k3:identity');
    const replacing = stack.read('k3:identity', () => {
      loads += 1;
      return fresh.promise;
    });
    await reachFlight();
    old.resolve('old');
    await leader;
    await stack.drop('k3:identity');
    const afterSecondBust = stack.read('k3:identity', async () => {
      loads += 1;
      return 'newest';
    });
    expect(await afterSecondBust).toBe('newest');
    fresh.resolve('fresh');
    await replacing;
    expect(loads).toBe(2);
  });
});

/**
 * The stampede guard's own arrivals: the feed's comment expects ~1,600 joiners on one load. Each
 * asking the fence walks every mark since the sample against every scope it covers, and a cover per
 * reader grew those scopes, so N tagged joiners cost N x marks x N. Counted in the fence's calls and
 * never in wall clock: the count is what cannot flake, and what the event loop pays is its product.
 */
describe('joiners on one held load cost the fence nothing while nothing moved', () => {
  const countingSamples = () => {
    const counts = { isValid: 0, covered: 0 };
    const real = fenceModule.sampleFence;
    const spy = spyOn(fenceModule, 'sampleFence').mockImplementation((scope) => {
      const fence = real(scope);
      return {
        isValid: () => {
          counts.isValid += 1;
          return fence.isValid();
        },
        cover: (next) => {
          counts.covered += 1;
          fence.cover(next);
        },
      };
    });
    return { counts, restore: () => spy.mockRestore() };
  };

  test('2,000 tagged joiners, 200 unrelated marks: a bounded count of fence calls', async () => {
    const { counts, restore } = countingSamples();
    try {
      const old = deferred<string>();
      const stack = cacheStack([fakeTier('lru', [])]);
      const options = { tags: [tag('k3bound')] };
      const leader = stack.read('k3:bound', () => old.promise, options);
      await Bun.sleep(0);
      for (let mark = 0; mark < 200; mark += 1) {
        markInvalidated({ tags: [tag(`k3unrelated${mark}`)] });
      }
      const readers = Array.from({ length: 2_000 }, () =>
        stack.read('k3:bound', () => old.promise, options),
      );
      await Bun.sleep(0);
      // The walk of the lookup's own fence is per read and takes no marks to speak of: only the
      // load's fence is at issue, and `sampleFence` is called for both, so the count is over both.
      counts.isValid = 0;
      counts.covered = 0;
      const more = Array.from({ length: 500 }, () =>
        stack.read('k3:bound', () => old.promise, options),
      );
      await Bun.sleep(0);
      old.resolve('value');
      await Promise.all([leader, ...readers, ...more]);
      // Each lookup misses without promoting, so none asks its own fence. Publishing asks a fixed few.
      expect(counts.isValid).toBeLessThan(10);
      expect(counts.covered).toBeLessThan(10);
    } finally {
      restore();
    }
  });
});

describe('the fence outlives the work, up to the moment the flight lets go of the key', () => {
  // The two instants that matter are a few microtasks apart and fall where the await count says,
  // so both are walked: the mark lands `markAt` ticks after the load resolves, the read `readAt`
  // after that. A mark after `work` returned leaves its fence valid at that return, so only a fence
  // still held then can stop this read joining.
  test('a bust and a read landing anywhere in the settle', async () => {
    for (let markAt = 0; markAt < 14; markAt += 1) {
      for (let readAt = 0; readAt < 14; readAt += 1) {
        const key = `k3:walk:${markAt}:${readAt}`;
        const old = deferred<string>();
        const held = deferred<void>();
        let gets = 0;
        const stack = cacheStack([
          {
            name: 'lru',
            async get<T>(): Promise<CacheEntry<T> | undefined> {
              gets += 1;
              if (gets > 1) await held.promise;
              return undefined;
            },
            async set(): Promise<void> {},
            async del(): Promise<void> {},
            async invalidateTags() {
              return { tier: 'lru' as const, keys: [] };
            },
          },
        ]);
        const leader = stack.read(key, () => old.promise);
        await Bun.sleep(0);
        const reader = stack.read(key, async () => 'new');
        await Bun.sleep(0);
        old.resolve('old');
        for (let tick = 0; tick < markAt; tick += 1) await Promise.resolve();
        markInvalidated({ key });
        for (let tick = 0; tick < readAt; tick += 1) await Promise.resolve();
        held.resolve();
        expect(await reader).toBe('new');
        await leader;
      }
    }
  });

  test('the stack keeps an entry exactly while the flight holds the key', async () => {
    const real = leadingModule.leadingLoads;
    let loads: leadingModule.LeadingLoads | undefined;
    const spy = spyOn(leadingModule, 'leadingLoads').mockImplementation(() => {
      loads = real();
      return loads;
    });
    try {
      const timers: (() => void)[] = [];
      const stack = cacheStack([fakeTier('lru', [])], {
        schedule: (fn) => {
          timers.push(fn);
          return () => undefined;
        },
      });
      await stack.read('k3:size:settled', async () => 'value');
      expect(loads?.size).toBe(0);
      void stack.read('k3:size:wedged', () => new Promise<string>(() => undefined));
      await Bun.sleep(0);
      expect(loads?.size).toBe(1);
      for (const fire of timers) fire();
      expect(loads?.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
