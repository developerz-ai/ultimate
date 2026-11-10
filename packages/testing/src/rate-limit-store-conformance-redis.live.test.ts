// The conformance suite over the Redis store and a real server (`TEST_REDIS_URL`): the memory run
// proves the checks, this one proves the take script meets them. One namespace per run, so two
// runs against one server never share a bucket.

import { afterAll, beforeAll, describe } from 'bun:test';
import { redisClient } from '@ultimat3/core/redis';
import { redisRateLimitStore } from '@ultimat3/http';
import { rateLimitStoreConformance } from './rate-limit-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
/** Past the default for the reason the Postgres twin gives: a degraded answer is memory's. */
const DEADLINE_MS = 10_000;

describe.skipIf(url === '')(testName('live', 'the redis rate-limit store'), () => {
  const prefix = `xlive-rl-conformance-${crypto.randomUUID()}`;
  const client = url === '' ? undefined : redisClient(url);

  // Connected up front: core's client refuses a command while it is still dialling, and the store
  // would then degrade to memory — a green run that never touched Redis.
  beforeAll(async () => {
    await client?.connect();
  });

  afterAll(async () => {
    if (client === undefined) return;
    const found: unknown = await client.send('KEYS', [`${prefix}:*`]);
    for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    client.close();
  });

  behavesLike(rateLimitStoreConformance, () =>
    redisRateLimitStore({
      client: client as NonNullable<typeof client>,
      prefix,
      deadlineMs: DEADLINE_MS,
    }),
  );
});
