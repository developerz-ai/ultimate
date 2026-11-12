// The Redis driver ships each Lua script once per server, not once per operation: `EVALSHA` by
// the script's SHA-1, `EVAL` only when the server answers `NOSCRIPT` (a restart, a failover).

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { RedisSender } from './driver-redis';
import { redisJobDriver } from './driver-redis';
import { REDIS_ENQUEUE } from './driver-redis-scripts';

const sha1 = (text: string): string => new Bun.CryptoHasher('sha1').update(text).digest('hex');

const noScript = (): unknown =>
  Object.assign(new Error('NOSCRIPT No matching script. Please use EVAL.'), {
    code: 'ERR_REDIS_SERVER_ERROR',
  });

/** A server whose script cache is `cached`: `EVAL` fills it, `EVALSHA` misses it as Redis does. */
function server(cached = new Set<string>()) {
  const sent: { readonly command: string; readonly first: string }[] = [];
  const client: RedisSender = {
    send(command, args) {
      const first = args[0] ?? '';
      sent.push({ command, first });
      if (command === 'EVALSHA' && !cached.has(first)) return Promise.reject(noScript());
      if (command === 'EVAL') cached.add(sha1(first));
      return Promise.resolve(['created', 'j1', 'r1']);
    },
  };
  return { client, sent };
}

const request = { name: 'n', queue: 'q', input: null, idempotencyKey: 'k', maxAttempts: 1 };
const clock = frozenClock(Date.parse('2026-11-12T00:00:00.000Z'));

describe('redisJobDriver · script shipping', () => {
  test('an operation sends the SHA, not the script, once the server holds it', async () => {
    const { client, sent } = server(new Set([sha1(REDIS_ENQUEUE)]));
    await redisJobDriver({ client, clock }).enqueue(request);
    expect(sent).toEqual([{ command: 'EVALSHA', first: sha1(REDIS_ENQUEUE) }]);
  });

  test('NOSCRIPT falls back to EVAL once, and the next operation is EVALSHA again', async () => {
    const { client, sent } = server();
    const driver = redisJobDriver({ client, clock });
    expect(await driver.enqueue(request)).toEqual({ id: 'j1', runId: 'r1', deduped: false });
    await driver.enqueue(request);
    expect(sent.map((entry) => entry.command)).toEqual(['EVALSHA', 'EVAL', 'EVALSHA']);
    expect(sent[1]?.first).toBe(REDIS_ENQUEUE);
  });

  test('any other server error passes through, and the script is not re-sent', async () => {
    const sent: string[] = [];
    const client: RedisSender = {
      send(command) {
        sent.push(command);
        return Promise.reject(
          Object.assign(new Error('ERR Error running script'), { code: 'ERR_REDIS_SERVER_ERROR' }),
        );
      },
    };
    const refusal = await redisJobDriver({ client, clock })
      .enqueue(request)
      .then(
        () => expect.unreachable('a failing script answered'),
        (error: unknown) => error,
      );
    expect(String(refusal)).toContain('Error running script');
    expect(sent).toEqual(['EVALSHA']);
  });
});
