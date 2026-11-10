// The Redis tier answers the value shape every tier owes, over the fake client, and still reads a
// payload written before the codec. Before one codec a `Date` was an ISO string on the pod that read
// it from Redis and a `bigint` made the write throw. The in-process tiers' half (LRU, memo: shape,
// shared references, cycles) is `@ultimat3/testing`'s `cacheTierConformance`, run over both.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
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

const tiers = (): readonly CacheTier[] => [redisTier({ client: fakeRedis(), rng: () => 0 })];

describe('one value shape, whichever tier answered', () => {
  test('a Date, a bigint and plain JSON come back identical from Redis', async () => {
    for (const tier of tiers()) {
      await tier.set('k', SAMPLE);
      const hit = await tier.get<typeof SAMPLE>('k');
      expect(hit?.value).toEqual(SAMPLE);
      expect(hit?.value.at).toBeInstanceOf(Date);
      expect(typeof hit?.value.total).toBe('bigint');
      expect(hit?.value.rows[0]?.seenAt).toBeInstanceOf(Date);
    }
  });

  test('a Map and a Set survive Redis rather than collapsing to {}', async () => {
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
