// Which Redis a `redis` rung reads. The tier check read only `REDIS_URL` from the boot's env while
// the client core builds read `REDIS_URL` then `VALKEY_URL` from `process.env`: a VALKEY_URL-only
// deployment was refused ("set REDIS_URL") though the client would connect, and a boot handed an
// env other than the process's dialled a server the check never looked at.

import { afterEach, describe, expect, test } from 'bun:test';
import type { RedisLike } from '@ultimat3/cache';
import { isolateTiers, noopPurgeDriver, registeredTiers } from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { startCacheTiers } from './runtime-cache';

let release: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const printWarning = logger.warn;
afterEach(async () => {
  await release?.();
  release = undefined;
  restore?.();
  restore = undefined;
  logger.warn = printWarning;
});

/** A client that answers every read with a miss and records the URL it was built for. */
const recording =
  (dialled: string[]) =>
  (url: string): RedisLike => {
    dialled.push(url);
    return {
      get: async () => null,
      set: async () => 'OK',
      send: async () => null,
    };
  };

describe('the redis rung reads the boot env, in core order', () => {
  test('VALKEY_URL alone builds the rung, and its client dials that URL — at the first read', async () => {
    restore = isolateTiers();
    const dialled: string[] = [];
    release = startCacheTiers({
      env: { VALKEY_URL: 'redis://valkey.internal:6379' },
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: ['redis'],
      redisClient: recording(dialled),
    });
    const [tier] = registeredTiers();
    expect(tier?.name).toBe('redis');
    // Selected, never dialled: the first command builds the client.
    expect(dialled).toEqual([]);
    await tier?.get('k');
    expect(new Set(dialled)).toEqual(new Set(['redis://valkey.internal:6379']));
  });

  test('a VALKEY_URL nothing names is warned about under its own key', () => {
    restore = isolateTiers();
    const warnings: unknown[] = [];
    logger.warn = (line: string, meta?: Record<string, unknown>): void => {
      warnings.push([line, meta]);
    };
    release = startCacheTiers({
      env: { VALKEY_URL: 'redis://valkey.internal:6379' },
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: ['lru'],
    });
    expect(warnings).toContainEqual([
      'cache.tier.unnamed',
      { tier: 'redis', source: 'VALKEY_URL' },
    ]);
  });
});
