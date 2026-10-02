// Two replicas, one Redis, and a bust the second replica never hears about. The fence in
// `fence.ts` is module state, so replica A's in-flight `load()` cannot see replica B's bust until
// the broadcast arrives — and when it is lost, A republishes the pre-write value into the SHARED
// tier, where every replica promotes it for the full TTL. No Lua is involved on this path: the
// generations are plain `SET`/`GET`, which the recording fake holds as state like any other value.

import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { createLruTier } from './lru';
import { REDIS_INVALIDATE_SCRIPT } from './redis';
import type { FakeRedis } from './redis-fake';
import { fakeRedis, tierFor } from './redis-fake';
import type { CacheTag } from './tags';
import { tag } from './tags';
import { createCacheStack } from './tiers';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Replica B, as replica A experiences it when the broadcast is lost: the shared tier is busted
 * and NOTHING reaches A's process — no `invalidateTags()`, so no mark in A's `fence.ts`. Calling
 * B's tier directly is that, exactly; a second copy of the module graph would add nothing to it.
 */
const bustFromAnotherReplica = async (client: FakeRedis, tags: readonly CacheTag[]) => {
  client.answerEval(REDIS_INVALIDATE_SCRIPT, []);
  await tierFor(client).invalidateTags(tags);
};

/** Replica A: its own LRU, the shared Redis, and a `load()` the test holds open. */
const replicaA = (client: FakeRedis, clock?: Clock) => {
  const lru = createLruTier({ rng: () => 0 });
  const redis = tierFor(client, clock === undefined ? {} : { clock });
  return { lru, stack: createCacheStack([lru, redis]) };
};

const raceABust = async (
  owned: readonly CacheTag[],
  bust: readonly CacheTag[],
): Promise<{ shared: string | null; local: unknown }> => {
  const client = fakeRedis();
  const { lru, stack } = replicaA(client);
  const started = deferred<void>();
  const gate = deferred<string>();
  const read = stack.read(
    'feed',
    () => {
      started.resolve();
      return gate.promise;
    },
    { ttlMs: 60_000, tags: owned },
  );
  await started.promise;
  await bustFromAnotherReplica(client, bust);
  gate.resolve('pre-write rows');
  // The reader is still answered: a fence declines to publish, it never fails a business read.
  expect(await read).toBe('pre-write rows');
  return { shared: await client.get('x:c:feed'), local: lru.cache.get('feed') };
};

describe('a bust on another replica fences a fill on this one, through the shared tier', () => {
  test('a ROW bust during the load of that row: nothing is published', async () => {
    const after = await raceABust([tag('post', '1')], [tag('post', '1')]);
    expect(after.shared).toBeNull();
    // The near tier goes too: this replica now KNOWS the value is stale, and nothing else will
    // ever tell it — the broadcast that would have cleared its LRU is the one that was lost.
    expect(after.local).toBeUndefined();
  });

  test('a COLLECTION bust during the load of one of its rows', async () => {
    expect((await raceABust([tag('post', '1')], [tag('post')])).shared).toBeNull();
  });

  test('a ROW bust during the load of the list that contains it', async () => {
    expect((await raceABust([tag('post')], [tag('post', '1')])).shared).toBeNull();
  });

  test('a COLLECTION bust during the load of the list', async () => {
    expect((await raceABust([tag('post')], [tag('post')])).shared).toBeNull();
  });

  test('a bust of ANOTHER row leaves this fill alone — the fence is `tagMatches`, not "post"', async () => {
    const after = await raceABust([tag('post', '1')], [tag('post', '2')]);
    expect(after.shared).not.toBeNull();
    expect(after.local).toBeDefined();
  });

  test('a bust of another entity leaves this fill alone', async () => {
    expect((await raceABust([tag('post', '1')], [tag('user')])).shared).not.toBeNull();
  });

  test('an untagged fill has nothing to fence and is published', async () => {
    expect((await raceABust([], [tag('post')])).shared).not.toBeNull();
  });

  test('a bust that finished BEFORE the load began does not fence it', async () => {
    const client = fakeRedis();
    const { stack } = replicaA(client);
    await bustFromAnotherReplica(client, [tag('post', '1')]);

    await stack.read('feed', () => Promise.resolve('fresh'), {
      ttlMs: 60_000,
      tags: [tag('post', '1')],
    });

    expect(await client.get('x:c:feed')).not.toBeNull();
  });
});

describe('a generation is a lease, so a fence it can no longer vouch for declines', () => {
  test('a load that outlived the proof window is not published to the shared tier', async () => {
    // A generation key expires. Sampled absent, set by a bust, expired again: the two readings
    // are equal and the stale value would go out. Past the window nothing can be proven either
    // way, so the answer is the conservative one — one refetch, never a stale TTL.
    let now = 1_700_000_000_000;
    const clock = { now: () => new Date(now), monotonic: () => now } as Clock;
    const client = fakeRedis();
    const { lru, stack } = replicaA(client, clock);

    await stack.read(
      'feed',
      () => {
        now += 61_000;
        return Promise.resolve('slow');
      },
      { ttlMs: 60_000, tags: [tag('post', '1')] },
    );

    expect(await client.get('x:c:feed')).toBeNull();
    // Unprovable is not busted: nothing says the value is stale, so the near tier keeps it. A
    // shared store that cannot vouch for a value must not empty a process-local cache.
    expect(lru.cache.get('feed')?.value).toBe('slow');
  });

  test('a shared tier that could not be SAMPLED is skipped, and the near tier still fills', async () => {
    const client = fakeRedis();
    const down: FakeRedis = {
      ...client,
      get: (key) =>
        key.includes(':g:') ? Promise.reject(new Error('redis is down')) : client.get(key),
    };
    const { lru, stack } = replicaA(down);

    const value = await stack.read('feed', () => Promise.resolve('rows'), {
      ttlMs: 60_000,
      tags: [tag('post', '1')],
    });

    expect(value).toBe('rows');
    expect(await client.get('x:c:feed')).toBeNull();
    expect(lru.cache.get('feed')?.value).toBe('rows');
  });

  test('a joiner tag the fence never sampled is unprovable, not waved through', async () => {
    const client = fakeRedis();
    const { stack } = replicaA(client);
    const started = deferred<void>();
    const gate = deferred<string>();
    const leader = stack.read(
      'feed',
      () => {
        started.resolve();
        return gate.promise;
      },
      { ttlMs: 60_000, tags: [tag('post', '1')] },
    );
    await started.promise;
    const joiner = stack.read('feed', () => Promise.resolve('never runs'), {
      ttlMs: 60_000,
      tags: [tag('user', '9')],
    });
    // The joiner's first `get`s have to land before the leader's load resolves, or it never joins.
    await new Promise<void>((resolve) => setImmediate(resolve));
    gate.resolve('rows');

    expect(await leader).toBe('rows');
    expect(await joiner).toBe('rows');
    expect(await client.get('x:c:feed')).toBeNull();
  });
});

describe('what the fence costs on the wire', () => {
  test('a bust writes its generations BEFORE it reads the buckets', async () => {
    // The order is the proof. Generation first: a fill that re-checks after its SET either sees
    // the new generation, or wrote early enough that the bucket read below finds and deletes it.
    const client = fakeRedis();
    await bustFromAnotherReplica(client, [tag('post', '1')]);

    const wire = client.sent.map((entry) =>
      entry[0] === 'EVAL' ? 'READ' : `${String(entry[0])} ${String(entry[1])}`,
    );
    expect(wire.slice(0, 3)).toEqual(['SET x:g:{post}:r:1', 'SET x:g:{post}:a', 'READ']);
  });

  test('every generation key carries the entity hash tag and a lease', async () => {
    const client = fakeRedis();
    await bustFromAnotherReplica(client, [tag('post', '1'), tag('user')]);

    const generations = client.sent.filter((entry) => entry[0] === 'SET');
    expect(generations.map((entry) => entry[1])).toEqual([
      'x:g:{post}:r:1',
      'x:g:{post}:a',
      'x:g:{user}:c',
      'x:g:{user}:a',
    ]);
    for (const entry of generations) expect(entry.slice(3)).toEqual(['PX', '120000']);
  });

  test('two busts are two generations', async () => {
    // A token that repeated would read to a fence as "nothing happened in between".
    const client = fakeRedis();
    await bustFromAnotherReplica(client, [tag('post')]);
    await bustFromAnotherReplica(client, [tag('post')]);

    const tokens = client.sent.filter((entry) => entry[0] === 'SET').map((entry) => entry[2]);
    expect(tokens).toHaveLength(4);
    expect(new Set(tokens).size).toBe(2);
  });
});
