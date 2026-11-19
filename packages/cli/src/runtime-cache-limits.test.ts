// A rung's limits have one home: `cacheTiers` in `runtime.ts`. What the boot must keep true for it:
// the limit written there is the one enforced, and the rung the boot would otherwise have built is
// not built beside it. The one thing a tuned Redis rung gives up, the boot says out loud.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import {
  CacheTooLargeError,
  isolateTiers,
  lruTier,
  noopPurgeDriver,
  redisTier,
  registeredTiers,
} from '@ultimat3/cache';
import type { CacheTierName } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import { InProcessTransport } from '@ultimat3/realtime/server';
import type { Env } from './runtime-bindings';
import { startCacheTiers } from './runtime-cache';

const warnings: { line: string; meta: unknown }[] = [];
const printWarning = logger.warn;
let release: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;

beforeEach(() => {
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

const idleRedis = { get: async () => null, set: async () => 'OK', send: async () => null };

const boot = (tiers: readonly CacheTierName[], supplied: readonly CacheTier[], env: Env = {}) => {
  release = startCacheTiers({
    env,
    purge: noopPurgeDriver(),
    transport: new InProcessTransport(),
    tiers,
    supplied,
  });
};

const rung = (name: CacheTierName): CacheTier => {
  const tier = registeredTiers().find((candidate) => candidate.name === name);
  return tier ?? expect.unreachable(`the boot registered no ${name} rung`);
};

const defaultRedisWarnings = () =>
  warnings.filter((warning) => warning.line === 'cache.tier.default-redis');

describe('unit · a rung tuned in runtime.ts', () => {
  test('lruTier({ maxBytes }) is the budget the running rung enforces', async () => {
    boot(['request-memo', 'lru'], [lruTier({ maxBytes: 64 })]);
    await expect(rung('lru').set('k', 'x'.repeat(65), { tags: [] })).rejects.toBeInstanceOf(
      CacheTooLargeError,
    );
  });

  test('redisTier({ maxValueBytes }) is the budget the running rung enforces', async () => {
    boot(['redis'], [redisTier({ client: idleRedis, maxValueBytes: 64 })]);
    await expect(rung('redis').set('k', 'x'.repeat(65), { tags: [] })).rejects.toBeInstanceOf(
      CacheTooLargeError,
    );
  });

  test('jitterFraction: 0 reaches the rung: the lease written is the lease asked for', async () => {
    boot(['lru'], [lruTier({ jitterFraction: 0, rng: () => 1 })]);
    await rung('lru').set('k', 'v', { tags: [], ttlMs: 60_000 });
    const entry = await rung('lru').get('k');
    const left = (entry?.expiresAt ?? 0) - Date.now();
    // 5% of the lease is 3,000 ms: a spread that survived would land far below this floor.
    expect(left).toBeGreaterThan(59_000);
  });
});

describe('unit · a supplied redis rung with no client of its own', () => {
  test('no Redis URL: it boots, and the boot says the rung dials the local default', () => {
    boot(['redis'], [redisTier({ maxValueBytes: 2_048 })]);
    expect(defaultRedisWarnings()).toEqual([
      {
        line: 'cache.tier.default-redis',
        meta: { tier: 'redis', source: 'runtime.ts', expected: 'REDIS_URL or VALKEY_URL' },
      },
    ]);
  });

  test.each([['REDIS_URL'], ['VALKEY_URL']])('%s set: nothing to say', (key) => {
    boot(['redis'], [redisTier({ maxValueBytes: 2_048 })], {
      [key]: 'redis://cache.internal:6379',
    });
    expect(defaultRedisWarnings()).toEqual([]);
  });

  test('a rung holding its own client answered "which Redis" itself', () => {
    boot(['redis'], [redisTier({ client: idleRedis })]);
    expect(defaultRedisWarnings()).toEqual([]);
  });

  test('a rung cache.tiers does not name dials nothing, so it is not this warning', () => {
    boot(['lru'], [redisTier({ maxValueBytes: 2_048 })]);
    expect(defaultRedisWarnings()).toEqual([]);
  });
});

describe('cache.defaultTtlMs', () => {
  const leaseOf = async (tiers: readonly CacheTierName[], supplied: readonly CacheTier[]) => {
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers,
      supplied,
      defaultTtlMs: 5_000,
    });
    const before = Date.now();
    await rung('lru').set('k', 1);
    const entry = await rung('lru').get<number>('k');
    return (entry?.expiresAt ?? expect.unreachable('the value was not held')) - before;
  };

  test('is the lease of a value set with no ttlMs on the rung the boot builds', async () => {
    const lease = await leaseOf(['request-memo', 'lru'], []);
    // The tier's own default is 60 s; jitter shaves at most 5 % off 5 s.
    expect(lease).toBeLessThanOrEqual(5_000 + 50);
    expect(lease).toBeGreaterThan(4_000);
  });

  test('leaves a supplied rung with the lease it was built with', async () => {
    const lease = await leaseOf(['request-memo', 'lru'], [lruTier({ defaultTtlMs: 120_000 })]);
    expect(lease).toBeGreaterThan(100_000);
  });
});
