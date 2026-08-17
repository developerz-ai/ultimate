// Single responsibility: what a `cache:` read does when the tier under it refuses. A tier is
// best-effort infrastructure — a Redis refusal must degrade the cache, never fail the business
// read the database could have answered. That is the rule `packages/cache/CLAUDE.md` states and
// `createCacheStack` already kept; this file is what says the read path kept it after it stopped
// keeping a store of its own and started reading through that stack.

import { afterEach, describe, expect, test } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import { isolateTiers, recentTierFailures, registerTier, resetTiers } from '@ultimat3/cache';
import { createContext } from '@ultimat3/core';
import { readThrough } from './cache';

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('a read tier that refuses', () => {
  const refusingTier = (): CacheTier => ({
    name: 'redis',
    async get(): Promise<never> {
      throw new Error('redis: connection refused');
    },
    async set(): Promise<never> {
      throw new Error('redis: connection refused');
    },
    async del(): Promise<never> {
      throw new Error('redis: connection refused');
    },
    async invalidateTags(): Promise<never> {
      throw new Error('redis: connection refused');
    },
  });

  // Keyed uniquely rather than reset: the failure log is process-global, capped, and has no
  // exported way back — a file that cleared it would be deleting a neighbouring suite's evidence.
  const KEY = 'query-read-refusal-probe';

  test('answers the read from the source instead of failing it', async () => {
    restore = isolateTiers();
    resetTiers();
    registerTier(refusingTier());

    expect(await readThrough(createContext({}), KEY, 60_000, async () => 'rows', [])).toBe('rows');

    // Degraded, and SAYABLE: the refusal reaches `recentTierFailures()` under the name of the tier
    // that actually refused, so a stack running without its cache is answerable instead of merely
    // looking slow. It used to be labelled `query-read` — this package's own seam, which was the
    // whole problem: a rung nothing had registered and no fan-out could reach.
    const failures = recentTierFailures().filter((failure) => failure.key === KEY);
    expect(failures.map((failure) => failure.op).sort()).toEqual(['get', 'set']);
    expect(failures.every((failure) => failure.tier === 'redis')).toBe(true);
  });
});
