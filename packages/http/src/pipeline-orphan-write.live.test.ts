// The orphan write on Postgres, where the pin is a real connection: the real pipeline, 504, then 0
// rows after the orphan settles. The embedded suite is `pipeline-orphan-write.test.ts`. Skips
// unless `TEST_DATABASE_URL` is set.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetLifecycle, runToCompletion } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw, sql, withTransaction } from '@ultimat3/db';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter, type RouteHandler } from './router';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const pipelineFor = (handler: RouteHandler) =>
  httpPipeline({
    table: httpRouter([
      { method: 'POST', path: '/orders', meta: { name: 'orders', auth: 'public' }, handler },
    ]),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      requestTimeoutMs: 30,
    }),
  });

const post = (pipeline: ReturnType<typeof httpPipeline>): Promise<Response> =>
  pipeline.handle(new Request('http://app.test/orders', { method: 'POST' }), { role: 'web' });

afterAll(() => {
  resetLifecycle();
});

describe.skipIf(!hasPostgres)('live · postgres · a write past the request deadline', () => {
  let client: PostgresClient;
  const count = async (): Promise<number> => {
    const rows = await client.query<{ total: number }>(
      sql`select count(*)::int as total from x_orphan_probe`,
    );
    return rows[0]?.total ?? -1;
  };

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 2 } });
    await client.execute(raw('drop table if exists x_orphan_probe'));
    await client.execute(raw('create table x_orphan_probe (id serial primary key)'));
  });

  beforeEach(async () => {
    resetLifecycle();
    await client.execute(raw('delete from x_orphan_probe'));
  });

  afterEach(() => resetLifecycle());

  afterAll(async () => {
    await client.execute(raw('drop table if exists x_orphan_probe'));
    await client.close();
  });

  const twoInserts = (answered: Promise<void>) =>
    withTransaction(
      async (tx) => {
        await tx.execute(sql`insert into x_orphan_probe default values`);
        await answered;
        await tx.execute(sql`insert into x_orphan_probe default values`);
      },
      { client },
    );

  test('504, then 0 rows once the orphan settled', async () => {
    const answered = Promise.withResolvers<void>();
    let orphan: Promise<unknown> = Promise.resolve();
    const response = await post(
      pipelineFor(async () => {
        orphan = twoInserts(answered.promise);
        await orphan;
        return textResponse('written');
      }),
    );
    expect(response.status).toBe(504);
    answered.resolve();
    const ended = await orphan.then(
      () => 'committed',
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(ended).toBe('X_TIMEOUT');
    expect(await count()).toBe(0);
  });

  test('under runToCompletion: 504 all the same, and both rows land', async () => {
    const answered = Promise.withResolvers<void>();
    let orphan: Promise<unknown> = Promise.resolve();
    const response = await post(
      pipelineFor(async () => {
        orphan = runToCompletion(() => twoInserts(answered.promise));
        await orphan;
        return textResponse('written');
      }),
    );
    expect(response.status).toBe(504);
    answered.resolve();
    await orphan;
    expect(await count()).toBe(2);
  });
});
