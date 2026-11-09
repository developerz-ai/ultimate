// A paused Redis, through the real stack: the read that hung 45 s answers with its load at the
// tier's deadline and records it, and the reads after it skip the store without sending a byte.
// A stopped one refuses typed. `redis-deadline.test.ts` owns the mechanism; this file owns what
// `stack.read` and a bust make of it.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { DeadlineTimer } from '@ultimat3/core/outbound';
import { redisClient } from '@ultimat3/core/redis';
import { recordCacheEvents } from './cache-events-fixture';
import { CacheDriverUnavailableError, CacheLimitInvalidError } from './errors';
import type { RedisLike } from './redis';
import { redisTier } from './redis';
import { tag } from './tags';
import { cacheStack } from './tiers';

const events = recordCacheEvents();

const CONNECTION_CLOSED = 'ERR_REDIS_CONNECTION_CLOSED';

function pausedRedis() {
  const sent: string[] = [];
  const never = new Promise<never>(() => undefined);
  const client: RedisLike = {
    get: () => {
      sent.push('GET');
      return never;
    },
    set: () => {
      sent.push('SET');
      return never;
    },
    send: (command) => {
      sent.push(command);
      return never;
    },
  };
  return { client, sent };
}

function manualTimer() {
  const armed = new Map<number, () => void>();
  let next = 0;
  const timer: DeadlineTimer = {
    set(fire) {
      next += 1;
      armed.set(next, fire);
      return next;
    },
    clear(handle) {
      armed.delete(handle as number);
    },
  };
  /** Yield until the stack has sent its commands, then miss every deadline armed for them. */
  const missAll = async (): Promise<void> => {
    for (let turn = 0; turn < 50 && armed.size === 0; turn += 1) await Bun.sleep(0);
    for (const [handle, fire] of [...armed]) {
      armed.delete(handle);
      fire();
    }
  };
  return { timer, armed, missAll };
}

describe('unit · a paused redis under cacheStack', () => {
  test('the read answers with its load and records the missed deadline once', async () => {
    const { client, sent } = pausedRedis();
    const { timer, missAll } = manualTimer();
    const clock = frozenClock();
    const stack = cacheStack([redisTier({ client, timer, clock, buildId: null })], { clock });

    const read = stack.read('k', () => Promise.resolve('loaded'));
    await missAll();
    expect(await read).toBe('loaded');

    // GET and PTTL went out together and missed together; the fill behind them was parked.
    expect(sent).toEqual(['GET', 'PTTL']);
    const failures = events.failures();
    expect(failures.every((failure) => failure.code === 'X_CACHE_DRIVER_UNAVAILABLE')).toBe(true);
    expect(failures.filter((failure) => failure.message.includes('did not answer'))).toHaveLength(
      1,
    );
  });

  test('the next read inside the park sends nothing and arms no deadline', async () => {
    const { client, sent } = pausedRedis();
    const { timer, armed, missAll } = manualTimer();
    const clock = frozenClock();
    const stack = cacheStack([redisTier({ client, timer, clock, buildId: null })], { clock });
    const first = stack.read('a', () => Promise.resolve('one'));
    await missAll();
    await first;
    sent.length = 0;

    clock.advance(4_999);
    expect(await stack.read('b', () => Promise.resolve('two'))).toBe('two');
    expect(sent).toEqual([]);
    expect(armed.size).toBe(0);
  });

  test('a bust inside the park is still sent, and still bounded', async () => {
    const { client, sent } = pausedRedis();
    const { timer, armed, missAll } = manualTimer();
    const clock = frozenClock();
    const tier = redisTier({ client, timer, clock, buildId: null });
    const read = cacheStack([tier], { clock }).read('a', () => Promise.resolve('one'));
    await missAll();
    await read;
    sent.length = 0;

    // Skipped for a stall, a bust leaves stale rows serving until TTL — so it goes out anyway.
    const bust = tier.invalidateTags([tag('post', '1')]).then(
      () => expect.unreachable('a bust against a paused server answered'),
      (error: unknown) => error,
    );
    for (let turn = 0; turn < 50 && armed.size === 0; turn += 1) await Bun.sleep(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(armed.size).toBeGreaterThan(0);
    await missAll();
    expect(await bust).toBeInstanceOf(CacheDriverUnavailableError);
  });

  test('a stopped server refuses typed: the read records it, the bust rejects with it', async () => {
    // Bun's client while the connection is down: every command rejects at once with this code.
    const closed = (): Promise<never> =>
      Promise.reject(Object.assign(new Error('Connection closed'), { code: CONNECTION_CLOSED }));
    const client: RedisLike = { get: closed, set: closed, send: closed };
    const clock = frozenClock();
    const tier = redisTier({ client, clock, buildId: null });

    expect(await cacheStack([tier], { clock }).read('k', () => Promise.resolve('loaded'))).toBe(
      'loaded',
    );
    const failures = events.failures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((failure) => failure.code === 'X_CACHE_DRIVER_UNAVAILABLE')).toBe(true);

    const bust = await tier.invalidateTags([tag('post', '1')]).then(
      () => expect.unreachable('a bust against a stopped server answered'),
      (error: unknown) => error,
    );
    expect(bust).toBeInstanceOf(CacheDriverUnavailableError);
    expect((bust as CacheDriverUnavailableError).message).toContain(CONNECTION_CLOSED);
  });

  test("core's real client with nothing listening: the bust is typed, not Bun's error", async () => {
    // Port 1 answers nothing, so Bun's client refuses every command at once, as a stopped server.
    const client = redisClient('redis://127.0.0.1:1/4');
    const tier = redisTier({ client, clock: frozenClock(), buildId: null });
    const bust = await tier.invalidateTags([tag('post', '1')]).catch((error: unknown) => error);
    client.close();
    expect(bust).toBeInstanceOf(CacheDriverUnavailableError);
  });

  test('a server error reply is not a refusal of the connection and passes through', async () => {
    const reply = Object.assign(new Error('WRONGTYPE'), { code: 'ERR_REDIS_INVALID_RESPONSE' });
    const client: RedisLike = {
      get: () => Promise.reject(reply),
      set: () => Promise.reject(reply),
      send: () => Promise.reject(reply),
    };
    const tier = redisTier({ client, clock: frozenClock(), buildId: null });
    expect(await tier.invalidateTags([tag('post', '1')]).catch((error: unknown) => error)).toBe(
      reply,
    );
  });

  test('commandTimeoutMs is screened where it is named', () => {
    expect(() => redisTier({ client: pausedRedis().client, commandTimeoutMs: Number.NaN })).toThrow(
      CacheLimitInvalidError,
    );
  });
});
