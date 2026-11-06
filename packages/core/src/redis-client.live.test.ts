// `redisClient()` against a real server, through a real disconnect: `CLIENT KILL` on the client's
// own connection, never a stop of the shared test service. Refused at once while down, answering
// again on its own once Bun reconnects — the default client did neither (`redis-client.ts`).
//
//   set -a; . docker/test-services.env; set +a; bun test packages/core/src/redis-client.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { redisClient } from './redis-client';

const url = Bun.env['TEST_REDIS_URL'];
const hasRedis = typeof url === 'string' && url.length > 0;

/** Ask until `ready()` holds, or fail after `limitMs` of the server's and Bun's own time. */
async function until(ready: () => Promise<boolean> | boolean, limitMs: number): Promise<void> {
  const started = performance.now();
  while (!(await ready())) {
    if (performance.now() - started > limitMs) expect.unreachable(`not ready in ${limitMs} ms`);
    // real-clock: Bun's reconnect loop and the server's socket close run on their own timers.
    await Bun.sleep(10);
  }
}

describe.skipIf(!hasRedis)('live · redisClient · a killed connection', () => {
  // A path of its own, so this file's client is not one another suite in the process holds.
  const target = `${url ?? ''}/0`;
  // Built on first use, never in the describe body: `describe.skipIf` still runs that body, and an
  // empty URL throws `Invalid URL format` before the skip applies (CI's coverage run strips it).
  let opened: Bun.RedisClient | undefined;
  const admin = (): Bun.RedisClient => {
    opened ??= new Bun.RedisClient(url ?? '');
    return opened;
  };

  afterAll(() => {
    redisClient(target).close();
    opened?.close();
  });

  test('refuses at once while disconnected, then answers again with no restart', async () => {
    const client = redisClient(target);
    await until(() => client.connected, 2_000);
    const id = String((await client.send('CLIENT', ['ID'])) as unknown);
    expect(Number((await admin().send('CLIENT', ['KILL', 'ID', id])) as unknown)).toBe(1);
    await until(() => !client.connected, 2_000);

    const started = performance.now();
    const refusal = await client.get('x:redis-client-live').then(
      () => expect.unreachable('a command on a killed connection answered instead of refusing'),
      (error: unknown) => error,
    );
    expect(performance.now() - started).toBeLessThan(50);
    expect((refusal as { code?: unknown }).code).toBe('ERR_REDIS_CONNECTION_CLOSED');

    await until(
      () =>
        client.get('x:redis-client-live').then(
          () => true,
          () => false,
        ),
      5_000,
    );
    expect(client.connected).toBe(true);
  });
});
