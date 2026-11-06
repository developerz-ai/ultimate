// `x_failures` against a real Postgres: a bundle saved inside a request's transaction that then
// rolls back is still there — the whole reason the store writes outside it — and the reads `x repro`
// makes find it by request id, trace id and fingerprint. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import { uuidV7 } from '@ultimat3/core';
import { type PostgresClient, postgresClient, setDbClient } from './client';
import { failurePurgeTarget, postgresFailureStore, SQL_FAILURES_TABLE } from './failure-store-pg';
import { sql } from './sql';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const bundleFor = (requestId: string): FailureBundle => ({
  id: uuidV7(),
  fingerprint: `fp-${requestId}`,
  code: 'X_PLANTED_FAILURE',
  operation: 'POST /api/x',
  primitive: 'action',
  name: 'plant',
  at: Date.parse('2026-11-06T10:00:00.000Z'),
  requestId,
  traceId: `trace-${requestId}`,
  build: 'b1',
  input: { title: 'x' },
  masked: [],
  actor: null,
  flags: {},
  reads: [],
  truncated: false,
});

describeLive('live · postgres · x_failures', () => {
  let client: PostgresClient;
  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    setDbClient(client);
    for (const statement of SQL_FAILURES_TABLE.split(';').filter((s) => s.trim() !== '')) {
      await client.execute({ text: statement, values: [] });
    }
    await client.execute(sql`create table if not exists failure_store_probe (id text primary key)`);
  });
  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
  });

  test('a bundle saved inside a transaction that rolls back survives it', async () => {
    const store = postgresFailureStore();
    const requestId = uuidV7();
    const bundle = bundleFor(requestId);
    const rolledBack = withTransaction(async (tx) => {
      await tx.execute(sql`insert into failure_store_probe (id) values (${requestId})`);
      await store.save(bundle);
      return Promise.reject(new Error('the request failed'));
    });
    await expect(rolledBack).rejects.toThrow('the request failed');
    const probe = await client.query(
      sql`select id from failure_store_probe where id = ${requestId}`,
    );
    expect(probe).toEqual([]);
    expect(await store.find(requestId)).toEqual(bundle);
    expect((await store.find(`trace-${requestId}`))?.id).toBe(bundle.id);
    expect((await store.latest(`fp-${requestId}`))?.id).toBe(bundle.id);
    expect(
      (await store.list({ code: 'X_PLANTED_FAILURE' })).some((row) => row.id === bundle.id),
    ).toBe(true);
  });

  test('the purge target removes bundles older than the window it was given', async () => {
    const store = postgresFailureStore();
    const bundle = bundleFor(uuidV7());
    await store.save(bundle);
    const target = failurePurgeTarget(store, { keepMs: 1000 });
    expect(await target.purgeExpired(bundle.at + 2000)).toBeGreaterThanOrEqual(1);
    expect(await store.find(bundle.id)).toBeUndefined();
  });
});
