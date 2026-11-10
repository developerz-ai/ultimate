// The step-store suite over the Redis driver's step hashes and a real server (`TEST_REDIS_URL`):
// the fenced checks claim real rows, so `REDIS_STEP_PUT_FENCED` is what answers them. One
// namespace per run, so a shared server survives two runs at once.

import { afterAll, describe } from 'bun:test';
import { redisJobDriver } from '@ultimat3/jobs/redis';
import { behavesLike } from './shared-examples';
import { stepStoreConformance } from './step-store-conformance';
import { testName } from './test-types';

const url = Bun.env['TEST_REDIS_URL'] ?? '';

describe.skipIf(url === '')(testName('live', 'the redis step store'), () => {
  const prefix = `xlive-steps-${crypto.randomUUID()}`;
  const client = url === '' ? undefined : new Bun.RedisClient(url);

  // `KEYS` over a namespace this run owns, in a teardown only: never a path the driver takes.
  afterAll(async () => {
    if (client === undefined) return;
    const found: unknown = await client.send('KEYS', [`{${prefix}}:*`]);
    for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    client.close();
  });

  behavesLike(stepStoreConformance, () =>
    redisJobDriver({ prefix, ...(client === undefined ? {} : { client }) }),
  );
});
