// The run's tenant refusal on a real Redis: a row queued for org B whose payload names org A is
// dead on its first attempt, its body never run — the memory and Postgres answer. Skips unless
// `TEST_REDIS_URL` is set.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { redisJobDriver } from './driver-redis';
import { resetJobs } from './job';
import { runOfForeignRow } from './job-tenant-fixture';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
const prefix = `xlive-tenant-${crypto.randomUUID()}`;

afterEach(() => resetJobs());

describe.skipIf(url === '')('live · redis · the run refuses a row queued for another org', () => {
  const client = url === '' ? undefined : new Bun.RedisClient(url);

  afterAll(async () => {
    if (client === undefined) return;
    const found: unknown = await client.send('KEYS', [`{${prefix}*`]);
    for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    client.close();
  });

  test('dead on its first attempt, the body never ran (redis)', async () => {
    const driver = redisJobDriver({ prefix, ...(client === undefined ? {} : { client }) });
    const { outcome, error, ran } = await runOfForeignRow(driver);
    expect(outcome).toBe('dead-lettered');
    expect(error).toContain('X_JOB_TENANT_MISMATCH');
    expect(ran).toEqual([]);
  });
});
