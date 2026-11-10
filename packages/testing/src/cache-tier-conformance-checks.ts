// The `CacheTier` contract, check by check: what every rung — the request memo, the LRU, Redis and
// yours — answers through the port alone. Lifted from `cache/src/tier-parity.test.ts` and
// `tier-value-shape.test.ts`; a semantic one rung holds is a stack whose hits depend on the rung.

import { expect } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import { tag } from '@ultimat3/cache';
import { isUltimateError } from '@ultimat3/core';

export interface CacheTierCheck {
  readonly name: string;
  run(tier: CacheTier): Promise<void>;
}

/** An entity and a key prefix per check, so one shared Redis serves two runs and a dead one. */
const scopeOf = () => {
  const id = crypto.randomUUID().replaceAll('-', '');
  return { entity: `e${id.slice(0, 12)}`, key: (name: string) => `conformance:${id}:${name}` };
};

async function refusalOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (caught) {
    return isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;
  }
  return 'resolved';
}

/** One row, its neighbour, and a list: the three keys every bust is judged on. */
const seeded = async (tier: CacheTier) => {
  const scope = scopeOf();
  const [one, two, feed] = [scope.key('row-1'), scope.key('row-2'), scope.key('feed')];
  await tier.set(one, 'one', { ttlMs: 60_000, tags: [tag(scope.entity, '1')] });
  await tier.set(two, 'two', { ttlMs: 60_000, tags: [tag(scope.entity, '2')] });
  await tier.set(feed, 'list', { ttlMs: 60_000, tags: [tag(scope.entity)] });
  const survivors = async (): Promise<readonly string[]> => {
    const found: string[] = [];
    for (const key of [one, two, feed]) if ((await tier.get(key)) !== undefined) found.push(key);
    return found;
  };
  return { entity: scope.entity, one, two, feed, survivors };
};

const SAMPLE = {
  at: new Date('2026-10-07T12:00:00.000Z'),
  total: 9_007_199_254_740_993n,
  byId: new Map([['a', 1]]),
  seen: new Set(['x', 'y']),
  rows: [{ id: 'a', seenAt: new Date('2026-01-01T00:00:00.000Z') }],
  nothing: null,
};

export const CACHE_TIER_CHECKS: readonly CacheTierCheck[] = [
  {
    name: 'a set value is a hit carrying its tags, a del makes it a miss, an unknown key misses',
    async run(tier) {
      const scope = scopeOf();
      const key = scope.key('k');
      await tier.set(key, 'v', { ttlMs: 60_000, tags: [tag(scope.entity, '1')] });
      const hit = await tier.get<string>(key);
      expect([hit?.value, hit?.tags]).toEqual(['v', [tag(scope.entity, '1')]]);
      await tier.del(key);
      expect(await tier.get(key)).toBeUndefined();
      expect(await tier.get(scope.key('never'))).toBeUndefined();
    },
  },
  {
    name: 'a Date, a bigint, a Map and a Set come back as themselves',
    async run(tier) {
      const key = scopeOf().key('shape');
      await tier.set(key, SAMPLE, { ttlMs: 60_000 });
      const value = (await tier.get<typeof SAMPLE>(key))?.value;
      expect(value).toEqual(SAMPLE);
      expect([value?.at, value?.rows[0]?.seenAt].every((at) => at instanceof Date)).toBe(true);
      expect([typeof value?.total, value?.byId instanceof Map, value?.seen instanceof Set]).toEqual(
        ['bigint', true, true],
      );
    },
  },
  {
    name: 'mutating the written object, or a hit, never reaches the next reader',
    async run(tier) {
      const key = scopeOf().key('shared');
      const written = { count: 1, tags: ['a'] };
      await tier.set(key, written, { ttlMs: 60_000 });
      written.count = 99;
      const first = await tier.get<typeof written>(key);
      expect(first?.value.count).toBe(1);
      first?.value.tags.push('leaked');
      expect((await tier.get<typeof written>(key))?.value.tags).toEqual(['a']);
    },
  },
  {
    name: 'a ROW bust takes the row and its collection, and spares the other rows',
    async run(tier) {
      const { entity, one, two, feed, survivors } = await seeded(tier);
      const report = await tier.invalidateTags([tag(entity, '1')]);
      expect([...report.keys].sort()).toEqual([feed, one].sort());
      expect(await survivors()).toEqual([two]);
    },
  },
  {
    name: 'a COLLECTION bust takes every row of its entity as well as the list',
    async run(tier) {
      const { entity, survivors } = await seeded(tier);
      await tier.invalidateTags([tag(entity)]);
      expect(await survivors()).toEqual([]);
    },
  },
  {
    name: 'a bust of no tags, or of another entity, clears nothing',
    async run(tier) {
      const { two, one, feed, survivors } = await seeded(tier);
      expect((await tier.invalidateTags([])).keys).toEqual([]);
      await tier.invalidateTags([tag(scopeOf().entity)]);
      expect(await survivors()).toEqual([one, two, feed]);
    },
  },
  {
    name: 'a ttlMs that is not positive and finite is X_CACHE_TTL_INVALID, and holds nothing',
    async run(tier) {
      const key = scopeOf().key('ttl');
      for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(await refusalOf(() => tier.set(key, 'v', { ttlMs }))).toBe('X_CACHE_TTL_INVALID');
      }
      expect(await tier.get(key)).toBeUndefined();
    },
  },
  {
    name: 'a value no tier can encode is X_CACHE_VALUE_UNENCODABLE, never a bare TypeError',
    async run(tier) {
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      const key = scopeOf().key('cycle');
      expect(await refusalOf(() => tier.set(key, cyclic, { ttlMs: 60_000 }))).toBe(
        'X_CACHE_VALUE_UNENCODABLE',
      );
      expect(await tier.get(key)).toBeUndefined();
    },
  },
];
