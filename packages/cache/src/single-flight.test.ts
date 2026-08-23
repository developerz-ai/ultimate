// The assertion that matters is the COUNT, not the value: a cache with no single-flight returns
// the right answer to everybody and asks the origin N times to do it. Every test here pins how
// many times the work ran.

import { describe, expect, test } from 'bun:test';
import { createSingleFlight as coreSingleFlight } from '@ultimat3/core';
import { createSingleFlight } from './single-flight';
import type { CacheEntry, CacheSetOptions, CacheTier } from './tiers';
import { createCacheStack } from './tiers';

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

describe('createSingleFlight', () => {
  test('N concurrent callers on one key run the work exactly ONCE', async () => {
    const flight = createSingleFlight();
    const gate = deferred<string>();
    let runs = 0;
    const work = (): Promise<string> => {
      runs += 1;
      return gate.promise;
    };

    const readers = Array.from({ length: 50 }, () => flight.run('feed', work));
    expect(runs).toBe(1);
    expect(flight.size).toBe(1);

    gate.resolve('loaded');

    expect(await Promise.all(readers)).toEqual(Array.from({ length: 50 }, () => 'loaded'));
    expect(runs).toBe(1);
  });

  test('two different keys do not join each other', async () => {
    const flight = createSingleFlight();
    const seen: string[] = [];
    const work = (key: string) => (): Promise<string> => {
      seen.push(key);
      return Promise.resolve(key);
    };

    const [a, b] = await Promise.all([flight.run('a', work('a')), flight.run('b', work('b'))]);

    expect([a, b]).toEqual(['a', 'b']);
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  test('the share ends when the load settles — a later caller loads again', async () => {
    const flight = createSingleFlight();
    let runs = 0;
    const work = (): Promise<number> => {
      runs += 1;
      return Promise.resolve(runs);
    };

    expect(await flight.run('k', work)).toBe(1);
    expect(flight.size).toBe(0);
    expect(await flight.run('k', work)).toBe(2);
    expect(runs).toBe(2);
  });

  test('a rejected load rejects every joiner AND clears the entry', async () => {
    // The failure this guards: an entry left behind by a rejection is one failure cached as a
    // permanent rejection — every later reader of that key gets the first error, forever.
    const flight = createSingleFlight();
    const gate = deferred<string>();
    let runs = 0;
    const failing = (): Promise<string> => {
      runs += 1;
      return gate.promise;
    };

    const first = flight.run('k', failing);
    const joiner = flight.run('k', failing);
    gate.reject(new Error('origin is down'));

    await expect(first).rejects.toThrow('origin is down');
    await expect(joiner).rejects.toThrow('origin is down');
    expect(runs).toBe(1);
    expect(flight.size).toBe(0);

    expect(await flight.run('k', () => Promise.resolve('recovered'))).toBe('recovered');
  });

  test('work that throws synchronously rejects rather than escaping, and clears', async () => {
    const flight = createSingleFlight();

    await expect(
      flight.run('k', () => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');
    expect(flight.size).toBe(0);
  });

  test('a joiner contributes to the leader, which reads the merge LATE', async () => {
    // A joiner shares the leader's write as well as its load, so anything it declared about that
    // write is silently dropped unless it reaches the leader before the leader publishes.
    const flight = createSingleFlight();
    const gate = deferred<string>();
    const seen: string[][] = [];
    const work = (shared: () => string[] | undefined) => async (): Promise<string> => {
      const value = await gate.promise;
      seen.push(shared() ?? []);
      return value;
    };

    const leader = flight.run<string, string[]>('k', (shared) => work(shared)(), {
      context: ['leader'],
      merge: (current, joining) => [...current, ...joining],
    });
    const joiner = flight.run<string, string[]>('k', (shared) => work(shared)(), {
      context: ['joiner'],
      merge: (current, joining) => [...current, ...joining],
    });

    gate.resolve('loaded');
    expect(await Promise.all([leader, joiner])).toEqual(['loaded', 'loaded']);
    expect(seen).toEqual([['leader', 'joiner']]);
  });

  test('a late settle from a replaced load does not drop the live one', async () => {
    // `settled` compares identity before deleting: without that, the first load's callback would
    // evict the second load's entry and every joiner after it would start its own.
    const flight = createSingleFlight();
    const first = deferred<string>();
    const firstCall = flight.run('k', () => first.promise);
    first.resolve('one');
    expect(await firstCall).toBe('one');

    const second = deferred<string>();
    let runs = 0;
    const secondCall = flight.run('k', () => {
      runs += 1;
      return second.promise;
    });
    const joiner = flight.run('k', () => {
      runs += 1;
      return Promise.resolve('should-not-run');
    });

    second.resolve('two');
    expect(await secondCall).toBe('two');
    expect(await joiner).toBe('two');
    expect(runs).toBe(1);
  });
});

// And the same property one layer up, where it actually pays: `createCacheStack.read`. The
// primitive above is only worth what the stack does with it.
describe('createCacheStack read: concurrent misses share ONE load', () => {
  /** Holds `load()` open so every reader is provably in flight before any of them resolves. */
  function gatedLoader(): {
    load: () => Promise<string>;
    release(): void;
    readonly runs: number;
  } {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((res) => {
      resolve = res;
    });
    let runs = 0;
    return {
      get runs() {
        return runs;
      },
      load() {
        runs += 1;
        return promise;
      },
      release() {
        resolve('loaded');
      },
    };
  }

  test('200 readers arriving inside one load() call the origin exactly once', async () => {
    // The outage this prevents: a feed cached for 60s and read 8,000x/s misses for the whole
    // ~200ms `load()` takes, because the write only lands after it resolves — ~1,600 identical
    // queries hit Postgres in one burst at every TTL boundary, forever.
    const calls: string[] = [];
    const stack = createCacheStack([fakeTier('lru', calls), fakeTier('redis', calls)]);
    const loader = gatedLoader();

    const readers = Array.from({ length: 200 }, () => stack.read('feed', loader.load));
    loader.release();
    const values = await Promise.all(readers);

    expect(loader.runs).toBe(1);
    expect(new Set(values)).toEqual(new Set(['loaded']));
    // One write-back per tier, not 200: the joiners share the leader's fill as well as its load.
    expect(calls.filter((entry) => entry.startsWith('set:'))).toEqual([
      'set:lru:feed',
      'set:redis:feed',
    ]);
  });

  test('a rejected load rejects every joiner and is not held as a permanent failure', async () => {
    const calls: string[] = [];
    const stack = createCacheStack([fakeTier('lru', calls)]);
    let attempts = 0;
    let fail = true;
    const load = (): Promise<string> => {
      attempts += 1;
      return fail ? Promise.reject(new Error('origin is down')) : Promise.resolve('recovered');
    };

    // Both handlers attach synchronously: a joiner left unhandled for even one tick is an
    // unhandled rejection, which is itself the bug a shared promise must not introduce.
    const settle = (promise: Promise<string>): Promise<string> =>
      promise.catch((error: unknown) => (error as Error).message);
    const first = settle(stack.read('k', load));
    const second = settle(stack.read('k', load));

    expect(await first).toBe('origin is down');
    expect(await second).toBe('origin is down');
    expect(attempts).toBe(1);

    fail = false;
    expect(await stack.read('k', load)).toBe('recovered');
    expect(attempts).toBe(2);
  });

  test("a joiner's tags and its shorter TTL reach the fill it shares", async () => {
    // The consequence of dropping them: the entry lands carrying only the leader's tags, so the
    // tag the joiner declared can never reach it and its invalidation silently never fires.
    const written: CacheSetOptions[] = [];
    const recorder: CacheTier = {
      name: 'lru',
      get: () => Promise.resolve(undefined),
      set: (_key, _value, options?: CacheSetOptions) => {
        written.push(options ?? {});
        return Promise.resolve();
      },
      del: () => Promise.resolve(),
      invalidateTags: () => Promise.resolve({ tier: 'lru' as const, keys: [] }),
    };
    const stack = createCacheStack([recorder]);
    const gate = deferred<string>();

    const leader = stack.read('post:1', () => gate.promise, {
      ttlMs: 300_000,
      tags: [{ entity: 'post' }],
    });
    const joiner = stack.read('post:1', () => Promise.resolve('never runs'), {
      ttlMs: 60_000,
      tags: [{ entity: 'post', id: '1' }],
    });

    gate.resolve('loaded');
    await Promise.all([leader, joiner]);

    expect(written).toHaveLength(1);
    expect(written[0]?.tags).toEqual([{ entity: 'post' }, { entity: 'post', id: '1' }]);
    // The SHORTEST lease of the two: an entry held longer than a caller asked for is stale to it.
    expect(written[0]?.ttlMs).toBe(60_000);
  });

  test('two stacks are two ladders and never join each other loads', async () => {
    const calls: string[] = [];
    const one = createCacheStack([fakeTier('lru', calls)]);
    const two = createCacheStack([fakeTier('lru', calls)]);
    let runs = 0;
    const load = (): Promise<string> => {
      runs += 1;
      return Promise.resolve('v');
    };

    await Promise.all([one.read('k', load), two.read('k', load)]);

    expect(runs).toBe(2);
  });
});

// The mechanism moved down to tier 0 and this package publishes it unchanged. Identity, not
// behaviour: four packages each had their own deduper and behavioural parity is what let them
// drift — a copy that passes every test above is still a second thing to fix.
describe("the mechanism is @ultimat3/core's, not a copy of it", () => {
  test("createSingleFlight IS core's function", () => {
    expect(createSingleFlight).toBe(coreSingleFlight);
  });

  // The one capability core adds over what this package shipped: a key held by a load that never
  // settles is freed, so later callers start a load of their own instead of joining a promise
  // nothing will ever resolve. The schedule is injected, so the deadline is provable without one.
  test("an injected deadline frees a wedged key, and the timer is a test's to fire", async () => {
    let fire = (): void => {};
    const flight = createSingleFlight({
      deadlineMs: 30_000,
      schedule: (fn) => {
        fire = fn;
        return (): void => {
          fire = (): void => {};
        };
      },
    });
    const wedged = deferred<string>();
    let runs = 0;
    const work = (): Promise<string> => {
      runs += 1;
      return wedged.promise;
    };

    void flight.run('k', work);
    expect(flight.size).toBe(1);
    fire();
    expect(flight.size).toBe(0);

    void flight.run('k', work);
    expect(runs).toBe(2);
    wedged.resolve('eventually');
  });
});
