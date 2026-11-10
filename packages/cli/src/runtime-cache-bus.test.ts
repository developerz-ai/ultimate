// The one rule for which bus carries cache invalidations, and the boot line that says it. Rung 1
// (Redis, no NATS) used to fall through to the in-process bus, so a second web replica never heard
// a bust; `runtime-cache-redis.live.test.ts` proves the Redis hop end to end.

import { afterEach, describe, expect, test } from 'bun:test';
import type { InvalidationBus } from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { logCacheBus, selectCacheBus } from './runtime-cache-bus';

const dialled: string[] = [];
let closed = 0;
const fakeRedisBus = (url: string): InvalidationBus => {
  dialled.push(url);
  return {
    name: 'redis',
    publish: async () => undefined,
    subscribe: async () => ({ unsubscribe: () => undefined }),
    onReconnect: () => () => undefined,
    close: async () => {
      closed += 1;
    },
  };
};

/** A transport that crosses processes, as NATS does — anything but the in-process bus. */
const crossProcess = (): Transport => {
  const local = new InProcessTransport();
  return {
    name: 'nats',
    shared: local.shared,
    publish: (subject, payload) => local.publish(subject, payload),
    subscribe: (subject, handler) => local.subscribe(subject, handler),
    // The in-process bus has no connection to lose: it never calls a listener.
    onReconnect: () => local.onReconnect(),
    close: () => local.close(),
  };
};

const printInfo = logger.info;
afterEach(() => {
  dialled.length = 0;
  closed = 0;
  logger.info = printInfo;
});

describe('selectCacheBus', () => {
  test('in-process bus and REDIS_URL: the hop rides Redis pub/sub', async () => {
    const selected = selectCacheBus({
      env: { REDIS_URL: 'redis://cache.internal:6379' },
      transport: new InProcessTransport(),
      redisPubSub: fakeRedisBus,
    });
    expect([selected.label, selected.source]).toEqual(['redis', 'REDIS_URL']);
    expect(dialled).toEqual(['redis://cache.internal:6379']);
    await selected.release();
    expect(closed).toBe(1);
  });

  test("VALKEY_URL alone selects it too, under core's precedence", () => {
    const selected = selectCacheBus({
      env: { VALKEY_URL: 'redis://valkey.internal:6379' },
      transport: new InProcessTransport(),
      redisPubSub: fakeRedisBus,
    });
    expect([selected.label, selected.source]).toEqual(['redis', 'VALKEY_URL']);
  });

  test('a transport that crosses processes wins over REDIS_URL: one hop, never two', async () => {
    const transport = crossProcess();
    const selected = selectCacheBus({
      env: { REDIS_URL: 'redis://cache.internal:6379' },
      transport,
      redisPubSub: fakeRedisBus,
    });
    expect(selected.bus).toBe(transport);
    expect([selected.label, selected.source]).toEqual(['nats', 'transport']);
    expect(dialled).toEqual([]);
    // The fanout transport is the boot's to close.
    await selected.release();
    expect(closed).toBe(0);
  });

  test('no Redis and no NATS: the in-process bus, said as such', () => {
    const transport = new InProcessTransport();
    const selected = selectCacheBus({ env: {}, transport, redisPubSub: fakeRedisBus });
    expect(selected.bus).toBe(transport);
    expect(selected.label).toBe('in-process');
  });

  test('the boot line names the bus and the key that chose it, never the URL', () => {
    const lines: { line: string; meta: unknown }[] = [];
    logger.info = (line: string, meta?: Record<string, unknown>): void => {
      lines.push({ line, meta });
    };
    logCacheBus(
      selectCacheBus({
        env: { REDIS_URL: 'redis://:secret@cache.internal:6379' },
        transport: new InProcessTransport(),
        redisPubSub: fakeRedisBus,
      }),
    );
    expect(lines).toEqual([
      { line: 'cache.broadcast', meta: { bus: 'redis', source: 'REDIS_URL' } },
    ]);
  });
});
