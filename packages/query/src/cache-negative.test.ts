// A null's lease. `negativeTtlMs` existed in `@ultimat3/cache` and no query could reach it: a
// `single: true` lookup that missed 40 ms before its row landed said "does not exist" for the whole
// `ttlMs`. Only `single` answers null; an empty LIST is a list and keeps the positive lease.

import { afterEach, describe, expect, test } from 'bun:test';
import type { CacheSetOptions, CacheTier } from '@ultimat3/cache';
import { declareTags, isolateDeclaredTags, isolateTiers, registerTier } from '@ultimat3/cache';
import { ctxOf } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { from } from './source';

interface Post {
  readonly id: string;
}

let restore: (() => void) | undefined;
const restoreTags = isolateDeclaredTags();
declareTags(['post']);

afterEach(() => {
  restore?.();
  restore = undefined;
  restoreTags();
});

/** The lease each write was given, by key order — the one fact this suite is about. */
function leaseTier(): CacheTier & { readonly leases: (number | undefined)[] } {
  const leases: (number | undefined)[] = [];
  return {
    name: 'lru',
    leases,
    get: async () => undefined,
    async set<T>(_key: string, _value: T, options?: CacheSetOptions) {
      leases.push(options?.ttlMs);
    },
    del: async () => undefined,
    invalidateTags: async () => ({ tier: 'lru', keys: [] }),
  };
}

const lookup = (rows: readonly Post[], single: boolean) =>
  query({
    input: t.object({ id: t.string }),
    policy: allow(),
    single,
    cache: { tags: [{ entity: 'post' }], ttlMs: 60_000, negativeTtlMs: 500 },
    sql: ({ id }) => from<Post>('posts', rows).where({ id }),
  }).named('postById');

function withTier(): ReturnType<typeof leaseTier> {
  restore = isolateTiers();
  const tier = leaseTier();
  registerTier(tier);
  return tier;
}

describe('cache.negativeTtlMs', () => {
  test('a single read answering null is written with negativeTtlMs', async () => {
    const tier = withTier();
    expect(await lookup([], true)({ id: 'p1' }, { ctx: ctxOf({}) })).toEqual([]);
    expect(tier.leases).toEqual([500]);
  });

  test('a single read answering a row keeps ttlMs', async () => {
    const tier = withTier();
    expect(await lookup([{ id: 'p1' }], true)({ id: 'p1' }, { ctx: ctxOf({}) })).toEqual([
      { id: 'p1' },
    ]);
    expect(tier.leases).toEqual([60_000]);
  });

  test('an empty list is not a null: ttlMs', async () => {
    const tier = withTier();
    expect(await lookup([], false)({ id: 'p1' }, { ctx: ctxOf({}) })).toEqual([]);
    expect(tier.leases).toEqual([60_000]);
  });

  test('a non-positive negativeTtlMs is refused at declaration, by the tier`s rule', () => {
    for (const negativeTtlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        query({
          input: t.object({}),
          policy: allow(),
          single: true,
          cache: { tags: [], negativeTtlMs },
          sql: () => from<Post>('posts', []),
        }),
      ).toThrow('X_QUERY_CACHE_TTL_INVALID');
    }
  });
});
