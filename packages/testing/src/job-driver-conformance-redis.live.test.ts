// The conformance suite over the Redis driver and a real server (`TEST_REDIS_URL`): the memory run
// proves the checks, this one proves the Lua scripts meet them. One namespace per run, so a shared
// server survives two runs at once; every check claims only from a queue it named.

import { afterAll, describe } from 'bun:test';
import { redisJobDriver } from '@ultimat3/jobs/redis';
import { jobDriverConformance } from './job-driver-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const url = Bun.env['TEST_REDIS_URL'] ?? '';

describe.skipIf(url === '')(testName('live', 'the redis job driver'), () => {
  const prefix = `xlive-jobs-${crypto.randomUUID()}`;
  const client = url === '' ? undefined : new Bun.RedisClient(url);

  // `KEYS` over a namespace this run owns, in a teardown: the cheapest way to leave the server as
  // it was found. Never a path the driver itself takes.
  afterAll(async () => {
    if (client === undefined) return;
    const found: unknown = await client.send('KEYS', [`{${prefix}}:*`]);
    for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    client.close();
  });

  behavesLike(jobDriverConformance, () =>
    redisJobDriver({ prefix, ...(client === undefined ? {} : { client }) }),
  );
});
