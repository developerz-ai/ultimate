// The deadline answers the socket; the handler does not know. A transaction still running at 504
// used to COMMIT afterwards: a caller told `X_TIMEOUT` (retryable) resent, and one row became two.
// The real pipeline against a real database: 504, then 0 rows after the orphan settles.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetLifecycle, runToCompletion, useContext } from '@ultimat3/core';
import { pgliteClient, raw, sql, withTransaction } from '@ultimat3/db';
import { defineHttpConfig } from './config';
import { requestTimedOut } from './errors';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter, type RouteHandler } from './router';

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();

const pipelineFor = (handler: RouteHandler) =>
  httpPipeline({
    table: httpRouter([
      { method: 'POST', path: '/orders', meta: { name: 'orders', auth: 'public' }, handler },
    ]),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      requestTimeoutMs: 20,
    }),
  });

const post = (pipeline: ReturnType<typeof httpPipeline>): Promise<Response> =>
  pipeline.handle(new Request('http://app.test/orders', { method: 'POST' }), { role: 'web' });

const count = async (): Promise<number> => {
  const rows = await client.query<{ total: number }>(
    sql`select count(*)::int as total from orphan_orders`,
  );
  return rows[0]?.total ?? -1;
};

beforeEach(async () => {
  resetLifecycle();
  await client.execute(raw('drop table if exists orphan_orders'));
  await client.execute(raw('create table orphan_orders (id serial primary key)'));
}, PGLITE_BOOT_MS);

afterEach(() => resetLifecycle());

afterAll(async () => {
  await client.close();
});

describe('a write still running when the deadline answers the socket', () => {
  test('X_TIMEOUT names the way through', () => {
    expect(requestTimedOut('POST', '/orders', 20).fix).toContain(
      'runToCompletion(() => withTransaction(fn))',
    );
  });

  test('a transaction over the deadline leaves 0 rows once the orphan settles', async () => {
    const answered = Promise.withResolvers<void>();
    let orphan: Promise<unknown> = Promise.resolve();
    const pipeline = pipelineFor(async () => {
      orphan = withTransaction(
        async (tx) => {
          await tx.execute(sql`insert into orphan_orders default values`);
          await answered.promise;
          await tx.execute(sql`insert into orphan_orders default values`);
        },
        { client },
      );
      await orphan;
      return textResponse('written');
    });

    const response = await post(pipeline);

    expect(response.status).toBe(504);
    answered.resolve();
    expect(await count()).toBe(0);
    // What this suite exists for: the orphan's end, not the answer.
    const ended = await orphan.then(
      () => 'committed',
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(ended).toBe('X_TIMEOUT');
    expect(await count()).toBe(0);
  });

  test('runToCompletion is the way to land it: 504 all the same, and the rows arrive', async () => {
    const answered = Promise.withResolvers<void>();
    let orphan: Promise<unknown> = Promise.resolve();
    let signalAborted: boolean | undefined;
    const pipeline = pipelineFor(async () => {
      orphan = runToCompletion(() =>
        withTransaction(
          async (tx) => {
            await tx.execute(sql`insert into orphan_orders default values`);
            await answered.promise;
            signalAborted = useContext().signal.aborted;
            await tx.execute(sql`insert into orphan_orders default values`);
          },
          { client },
        ),
      );
      await orphan;
      return textResponse('written');
    });

    const response = await post(pipeline);

    expect(response.status).toBe(504);
    answered.resolve();
    await orphan;
    expect(signalAborted).toBe(false);
    expect(await count()).toBe(2);
  });
});
