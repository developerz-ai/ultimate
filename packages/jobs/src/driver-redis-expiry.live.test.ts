// The expiry scenarios against the Redis driver and a real server, under a frozen clock: this
// proves `REDIS_CLAIM`'s expiry arm. Skips unless `TEST_REDIS_URL`.

import { afterAll, describe } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { driverExpiryScenarios } from './driver-expiry-fixture';
import { redisJobDriver } from './driver-redis';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
const clock = frozenClock('2026-11-12T00:00:00.000Z');
const client = url === '' ? undefined : new Bun.RedisClient(url);
let runs = 0;
const prefixes: string[] = [];

describe.skipIf(url === '')('when expiry buries a row, on the redis driver', () => {
  // `KEYS` over the namespaces this run owns, in a teardown only — never a path the driver takes.
  afterAll(async () => {
    if (client === undefined) return;
    for (const prefix of prefixes) {
      const found: unknown = await client.send('KEYS', [`{${prefix}}:*`]);
      for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    }
    client.close();
  });

  driverExpiryScenarios('redis', {
    driver() {
      runs += 1;
      const prefix = `xlive-expiry-${crypto.randomUUID()}-${runs}`;
      prefixes.push(prefix);
      return Promise.resolve(
        redisJobDriver({ prefix, clock, ...(client === undefined ? {} : { client }) }),
      );
    },
    now: () => Promise.resolve(clock.now().getTime()),
    elapse: (_driver, ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
  });
});
