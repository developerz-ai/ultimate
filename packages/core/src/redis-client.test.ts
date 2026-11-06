// The options are the measured record (`redis-client.ts`); these pin them and the URL precedence,
// so a refactor that drops one is a red test rather than a 31-second read in production.

import { describe, expect, test } from 'bun:test';
import { REDIS_CLIENT_OPTIONS, redisClient, redisUrl } from './redis-client';

describe('unit · redisClient', () => {
  test('a command while down refuses at once, and the client never stops reconnecting', () => {
    expect(REDIS_CLIENT_OPTIONS.enableOfflineQueue).toBe(false);
    expect(REDIS_CLIENT_OPTIONS.maxRetries).toBe(2_147_483_647);
    expect(REDIS_CLIENT_OPTIONS.connectionTimeout).toBe(1_000);
    expect(Object.isFrozen(REDIS_CLIENT_OPTIONS)).toBe(true);
  });

  test('REDIS_URL first, VALKEY_URL second, an empty value is unset, then the local default', () => {
    expect(redisUrl({ REDIS_URL: 'redis://a:6379', VALKEY_URL: 'redis://b:6379' })).toBe(
      'redis://a:6379',
    );
    expect(redisUrl({ REDIS_URL: '', VALKEY_URL: 'redis://b:6379' })).toBe('redis://b:6379');
    expect(redisUrl({ REDIS_URL: '  ' })).toBe('redis://localhost:6379');
    expect(redisUrl({})).toBe('redis://localhost:6379');
  });

  test('one client per process per URL', () => {
    // Port 1 answers nothing: the background connect is refused and the client keeps retrying,
    // which is the point — building one never throws and never waits.
    const one = redisClient('redis://127.0.0.1:1/0');
    const two = redisClient('redis://127.0.0.1:1/1');
    expect(redisClient('redis://127.0.0.1:1/0')).toBe(one);
    expect(two).not.toBe(one);
    one.close();
    two.close();
  });

  test('while unreachable a command is refused at once, never queued', async () => {
    const client = redisClient('redis://127.0.0.1:1/2');
    const refusal = await client.get('k').then(
      () => expect.unreachable('a command on a client with no connection answered'),
      (error: unknown) => error,
    );
    expect((refusal as { code?: unknown }).code).toBe('ERR_REDIS_CONNECTION_CLOSED');
    client.close();
  });
});
