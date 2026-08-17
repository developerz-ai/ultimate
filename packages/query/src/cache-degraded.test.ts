// Single responsibility: what a `cache:` read does when the tier under it refuses. A tier is
// best-effort infrastructure — a Redis refusal must degrade the cache, never fail the business
// read the database could have answered. That is the rule `packages/cache/CLAUDE.md` states and
// `createCacheStack` already kept, and this path did not.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { recentTierFailures } from '@ultimat3/cache';
import { createContext } from '@ultimat3/core';
import { readThrough } from './cache';
import type { ReadCache, ReadCacheEntry } from './read-cache';
import { getReadCache, MemoryReadCache, setReadCache } from './read-cache';

const original = getReadCache();

afterEach(() => {
  setReadCache(new MemoryReadCache());
});

afterAll(() => {
  setReadCache(original);
});

describe('a read tier that refuses', () => {
  class RefusingCache implements ReadCache {
    async get(): Promise<ReadCacheEntry | undefined> {
      throw new Error('redis: connection refused');
    }
    async set(): Promise<void> {
      throw new Error('redis: connection refused');
    }
    async delete(): Promise<void> {}
  }

  // Keyed uniquely rather than reset: the failure log is process-global, capped, and has no
  // exported way back — a file that cleared it would be deleting a neighbouring suite's evidence.
  const KEY = 'query-read-refusal-probe';

  test('answers the read from the source instead of failing it', async () => {
    setReadCache(new RefusingCache());

    expect(await readThrough(createContext({}), KEY, 60_000, async () => 'rows', [])).toBe('rows');

    // Degraded, and SAYABLE: the refusal reaches `recentTierFailures()` under its own label, so a
    // stack running without its cache is answerable instead of merely looking slow.
    const failures = recentTierFailures().filter((failure) => failure.key === KEY);
    expect(failures.map((failure) => failure.op).sort()).toEqual(['get', 'set']);
    expect(failures.every((failure) => failure.tier === 'query-read')).toBe(true);
  });
});
