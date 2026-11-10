// The cache tier conformance suite over the shared tier and a real server (`TEST_REDIS_URL`): the
// memory run proves the checks, this one proves the bucket keys and the lease script meet them. One
// namespace per run, so a shared server survives two runs at once; the teardown empties it.

import { afterAll, describe } from 'bun:test';
import { redisTier } from '@ultimat3/cache';
import { cacheTierConformance } from './cache-tier-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const url = Bun.env['TEST_REDIS_URL'] ?? '';

describe.skipIf(url === '')(testName('live', 'the redis cache tier'), () => {
  const prefix = `xlive-cache-${crypto.randomUUID()}`;
  const client = url === '' ? undefined : new Bun.RedisClient(url);

  // `KEYS` over a namespace this run owns, in a teardown: never a path the tier itself takes.
  afterAll(async () => {
    if (client === undefined) return;
    const found: unknown = await client.send('KEYS', [`${prefix}:*`]);
    for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    client.close();
  });

  behavesLike(cacheTierConformance, () =>
    redisTier({ prefix, buildId: null, rng: () => 0, ...(client === undefined ? {} : { client }) }),
  );
});
