// The Redis driver against a server it cannot reach: every command is the client's offline
// refusal, which the driver answers as `X_DRIVER_UNAVAILABLE` at once — and a refusal the SERVER
// gave passes through as itself. Split from `driver-redis.test.ts` at the file ceiling.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { RedisSender } from './driver-redis';
import { redisJobDriver } from './driver-redis';
import { DriverUnavailableError } from './errors';

const clock = () => frozenClock(0);

describe('redisJobDriver · an unreachable server', () => {
  /** What `Bun.RedisClient` with its offline queue off answers every command while down. */
  const closed = (): RedisSender => ({
    send: () =>
      Promise.reject(
        Object.assign(new Error('Connection is closed and offline queue is disabled'), {
          code: 'ERR_REDIS_CONNECTION_CLOSED',
        }),
      ),
  });
  const request = {
    name: 'mail.send',
    queue: 'default',
    input: null,
    idempotencyKey: 'k',
    maxAttempts: 3,
  };

  test('enqueue is X_DRIVER_UNAVAILABLE at once, never the client error', async () => {
    const driver = redisJobDriver({ client: closed(), clock: clock() });
    const refusal = await driver.enqueue(request).then(
      () => expect.unreachable('an enqueue against a closed connection answered'),
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DriverUnavailableError);
    expect((refusal as DriverUnavailableError).cause).toContain('EVAL');
    expect((refusal as DriverUnavailableError).fix).toStartWith('redis-cli');
  });

  test('so is a claim, and a step read through the same client', async () => {
    const driver = redisJobDriver({ client: closed(), clock: clock() });
    await expect(
      driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w1' }),
    ).rejects.toBeInstanceOf(DriverUnavailableError);
    await expect(driver.steps.get('r1', 'a')).rejects.toBeInstanceOf(DriverUnavailableError);
  });

  test('a refusal the SERVER gave is not an outage, and passes through as itself', async () => {
    const client: RedisSender = {
      send: () =>
        Promise.reject(Object.assign(new Error('NOSCRIPT'), { code: 'ERR_REDIS_SERVER_ERROR' })),
    };
    const refusal = await redisJobDriver({ client, clock: clock() })
      .enqueue(request)
      .then(
        () => expect.unreachable('a refused script answered'),
        (error: unknown) => error,
      );
    expect(refusal).not.toBeInstanceOf(DriverUnavailableError);
  });
});
