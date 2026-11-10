// `runtime.ts`'s `cacheTiers`: a supplied tier replaces the rung of its own name, `cache.tiers`
// still decides which rungs exist, and a supplied rung the config does not name is said out loud.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  isolateTiers,
  lruTier,
  noopPurgeDriver,
  redisTier,
  registeredTiers,
} from '@ultimat3/cache';
import type { CacheTier } from '@ultimat3/cache/adapter';
import type { CacheTierName } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { startCacheTiers } from './runtime-cache';

const warnings: { line: string; meta: unknown }[] = [];
let printWarning = logger.warn;
let release: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;

beforeEach(() => {
  printWarning = logger.warn;
  warnings.length = 0;
  logger.warn = (line: string, meta?: Record<string, unknown>): void => {
    warnings.push({ line, meta });
  };
  restore = isolateTiers();
});

afterEach(async () => {
  await release?.();
  release = undefined;
  restore?.();
  logger.warn = printWarning;
});

/** A client nothing dials: the tier is registered, never read, in these tests. */
const idleRedis = { get: async () => null, set: async () => 'OK', send: async () => null };

const start = (tiers: readonly CacheTierName[], supplied: readonly CacheTier[]) =>
  startCacheTiers({
    env: {},
    purge: noopPurgeDriver(),
    transport: new InProcessTransport(),
    tiers,
    supplied,
  });

describe('unit · supplied cache tiers', () => {
  test('a supplied tier replaces the rung of its own name; the rest are built', () => {
    const mine = lruTier();
    release = start(['request-memo', 'lru'], [mine]);
    const ladder = registeredTiers();
    expect(ladder.map((tier) => tier.name)).toEqual(['request-memo', 'lru']);
    expect(ladder[1]).toBe(mine);
  });

  test('a supplied redis rung needs no REDIS_URL: the app already answered "which Redis"', () => {
    const mine = redisTier({ client: idleRedis });
    release = start(['redis'], [mine]);
    expect(registeredTiers()).toEqual([mine]);
  });

  test('a supplied rung cache.tiers does not name is never registered, and the boot says so', () => {
    release = start(['request-memo'], [lruTier()]);
    expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo']);
    expect(warnings).toEqual([
      { line: 'cache.tier.unnamed', meta: { tier: 'lru', source: 'runtime.ts' } },
    ]);
  });
});
