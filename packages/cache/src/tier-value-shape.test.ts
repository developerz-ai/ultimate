// Every tier answers the SAME value shape for the same write, and no tier hands two readers one
// mutable object. Before one codec, the LRU returned the caller's live reference while Redis
// JSON round-tripped: a `Date` was a `Date` on the pod that wrote it and an ISO string on the pod
// that read it from Redis, a mutated hit leaked into every later reader, and a `bigint` made the
// Redis write throw — swallowed by `bestEffort`, so it never reached the shared tier at all.

import { describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext } from '@ultimat3/core';
import { lruTier } from './lru';
import { memoTier } from './memo';
import { redisTier } from './redis';
import { fakeRedis } from './redis-fake-fixture';
import type { CacheTier } from './tiers';

const SAMPLE = {
  at: new Date('2026-10-07T12:00:00.000Z'),
  total: 9_007_199_254_740_993n,
  rows: [{ id: 'a', seenAt: new Date('2026-01-01T00:00:00.000Z') }],
  label: 'plain',
  nothing: null,
};

const tiers = (): readonly CacheTier[] => [
  lruTier({ rng: () => 0 }),
  redisTier({ client: fakeRedis(), rng: () => 0 }),
];

describe('one value shape, whichever tier answered', () => {
  test('a Date, a bigint and plain JSON come back identical from the LRU and from Redis', async () => {
    for (const tier of tiers()) {
      await tier.set('k', SAMPLE);
      const hit = await tier.get<typeof SAMPLE>('k');
      expect(hit?.value).toEqual(SAMPLE);
      expect(hit?.value.at).toBeInstanceOf(Date);
      expect(typeof hit?.value.total).toBe('bigint');
      expect(hit?.value.rows[0]?.seenAt).toBeInstanceOf(Date);
    }
  });

  test('a Map and a Set survive both tiers rather than collapsing to {}', async () => {
    const value = { byId: new Map([['a', 1]]), seen: new Set(['x', 'y']) };
    for (const tier of tiers()) {
      await tier.set('k', value);
      const hit = await tier.get<typeof value>('k');
      expect(hit?.value.byId).toBeInstanceOf(Map);
      expect(hit?.value.byId.get('a')).toBe(1);
      expect(hit?.value.seen).toBeInstanceOf(Set);
      expect([...(hit?.value.seen ?? [])]).toEqual(['x', 'y']);
    }
  });
});

describe('no tier hands out a shared mutable reference', () => {
  const tiersInRequest: readonly (readonly [string, () => CacheTier])[] = [
    ['lru', () => lruTier({ rng: () => 0 })],
    ['request-memo', () => memoTier()],
  ];
  for (const [name, make] of tiersInRequest) {
    test(`${name}: mutating a hit, or the written object, never reaches the next reader`, async () => {
      // Inside a request, because the memo tier is a no-op outside one.
      await runWithContext(ctxOf(), async () => {
        const tier = make();
        const written = { count: 1, tags: ['a'], at: new Date(0) };
        await tier.set('k', written);
        written.count = 99;
        const first = await tier.get<typeof written>('k');
        expect(first?.value.count).toBe(1);
        first?.value.tags.push('leaked');
        const second = await tier.get<typeof written>('k');
        expect(second?.value.tags).toEqual(['a']);
        expect(second?.value.at).toBeInstanceOf(Date);
      });
    });
  }
});

describe('an entry written before the codec is still read', () => {
  test('a plain-JSON Redis payload decodes as it always did', async () => {
    const client = fakeRedis();
    const tier = redisTier({ client, buildId: null, rng: () => 0 });
    await client.send('SET', [
      'x:c:legacy',
      JSON.stringify({ v: { at: '2026-10-07' }, t: [] }),
      'PX',
      '60000',
    ]);
    const hit = await tier.get<{ at: string }>('legacy');
    expect(hit?.value).toEqual({ at: '2026-10-07' });
  });
});

describe('a value no tier can encode is refused with a code, never a bare TypeError', () => {
  test('a cycle', async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const tier of tiers()) {
      try {
        await tier.set('k', cyclic);
        expect.unreachable(`${tier.name} accepted a cyclic value`);
      } catch (error) {
        expect(isUltimateError(error) ? error.code : 'bare').toBe('X_CACHE_VALUE_UNENCODABLE');
      }
    }
  });
});
