// Which clock a Redis lease is measured on, against a real server: the server's own (`TIME`) unless
// a clock is injected, so two pods whose clocks disagree still agree on who holds a row — the
// guarantee pg gets from `now()` in every statement. Skips unless `TEST_REDIS_URL`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { redisJobDriver } from './driver-redis';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
const prefix = `xlive-clock-${crypto.randomUUID()}`;

describe.skipIf(url === '')('live · redis · one clock for every lease', () => {
  const client = url === '' ? undefined : new Bun.RedisClient(url);
  const on = { prefix, ...(client === undefined ? {} : { client }) };

  // Each pod's skew is the process clock a driver with none injected reads (`liveClock`).
  let restore: (() => void) | undefined;
  const podClockAt = (ms: number) => {
    restore?.();
    restore = installClock(frozenClock(new Date(ms)));
  };
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
  afterAll(async () => {
    const found: unknown = await client?.send('KEYS', [`{${prefix}}:*`]);
    for (const key of Array.isArray(found) ? found : []) await client?.send('DEL', [String(key)]);
    client?.close();
  });

  /** The server's own clock, as `TIME` answers it. */
  const serverMs = async (): Promise<number> => {
    const reply: unknown = await client?.send('TIME', []);
    const [seconds, micros] = Array.isArray(reply) ? reply.map(Number) : [Number.NaN, 0];
    return (seconds ?? Number.NaN) * 1000 + Math.floor((micros ?? 0) / 1000);
  };

  test('two workers whose clocks disagree by more than the renewal slack never both hold one row', async () => {
    // Two drivers on the PROCESS clock (none injected).
    const podA = redisJobDriver(on);
    const podB = redisJobDriver(on);
    const real = Date.UTC(2026, 10, 19);
    podClockAt(real);
    const queued = await podA.enqueue({
      name: 'skew.job',
      queue: 'skew',
      input: {},
      idempotencyKey: 'k',
      maxAttempts: 5,
      runAt: real - 60_000,
    });
    podClockAt(real - 31_000);
    const [held] = await podA.claim({
      queues: ['skew'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'A',
    });
    expect(held?.id).toBe(queued.id);
    const renewed = await podA.heartbeat(queued.id, {
      visibilityTimeoutMs: 30_000,
      workerId: 'A',
      claim: held?.claim ?? 0,
    });
    expect(renewed).toBe(true);

    // B runs 31 s ahead of A. Measured on each pod's own clock, A's lease had already lapsed for B.
    podClockAt(real);
    const taken = await podB.claim({
      queues: ['skew'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'B',
    });
    expect(taken).toEqual([]);
  });

  test('a lease stamps the server clock, and a renewal extends it from there', async () => {
    const driver = redisJobDriver(on);
    const server = await serverMs();
    podClockAt(server);
    await driver.enqueue({
      name: 'stamp.job',
      queue: 'stamp',
      input: {},
      idempotencyKey: 'k',
      maxAttempts: 1,
      runAt: server - 60_000,
    });
    // The pod believes it is a day behind; the stamps it gets back are the server's.
    podClockAt(server - 86_400_000);
    const [held] = await driver.claim({
      queues: ['stamp'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    });
    expect(Math.abs((held?.claimedAt ?? 0) - server)).toBeLessThan(5_000);
    expect(Math.abs((held?.visibleAt ?? 0) - (server + 30_000))).toBeLessThan(5_000);
  });
});
