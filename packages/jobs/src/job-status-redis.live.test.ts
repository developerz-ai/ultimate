// The tenant status and cancel scenarios against the Redis driver and a real server: this proves
// `REDIS_STATUS_FOR` and `REDIS_CANCEL_FOR`. Skips unless `TEST_REDIS_URL`.

import { afterAll, describe } from 'bun:test';
import { redisJobDriver } from './driver-redis';
import { jobStatusScenarios } from './job-status-fixture';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
const client = url === '' ? undefined : new Bun.RedisClient(url);
const prefixes: string[] = [];

describe.skipIf(url === '')('a tenant reads and cancels its own job, on the redis driver', () => {
  // `KEYS` over the namespaces this run owns, in a teardown only — never a path the driver takes.
  afterAll(async () => {
    if (client === undefined) return;
    for (const prefix of prefixes) {
      const found: unknown = await client.send('KEYS', [`{${prefix}}:*`]);
      for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    }
    client.close();
  });

  jobStatusScenarios('redis', {
    driver() {
      const prefix = `xlive-status-${crypto.randomUUID()}`;
      prefixes.push(prefix);
      return Promise.resolve(
        redisJobDriver({ prefix, ...(client === undefined ? {} : { client }) }),
      );
    },
  });
});
