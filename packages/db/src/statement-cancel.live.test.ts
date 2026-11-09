// A hung-up caller's read, on Postgres: the abort cancels `pg_sleep(5)` on the SERVER, the caller is
// thrown `X_ABORTED` at once, the backend is idle again and the pool's one connection answers the
// next statement. `max: 1`, so "the pool is back" is provable. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · a pooled read cancelled on abort', () => {
  let client: PostgresClient;
  let watcher: PostgresClient;

  beforeAll(() => {
    client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    watcher = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
  });

  afterAll(async () => {
    await client.close();
    await watcher.close();
  });

  test('abort mid pg_sleep(5): X_ABORTED within 200 ms, the backend idle, the pool answering', async () => {
    const { pid } = (await client.one<{ pid: number }>(sql`select pg_backend_pid() as pid`)) ?? {
      pid: 0,
    };
    const controller = new AbortController();
    const reading = runWithContext(ctxOf({ signal: controller.signal }), () =>
      client.query(sql`select pg_sleep(5)`),
    );
    // Wait until the server is actually inside the sleep: an abort before the send cancels nothing.
    // Each poll is a round trip on the watcher's own connection, so the wait is the server's.
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const row = await watcher.one<{ state: string }>(
        sql`select state from pg_stat_activity where pid = ${pid}`,
      );
      if (row?.state === 'active') break;
    }
    const aborted = performance.now();
    controller.abort();
    const error = await reading.then(
      () => expect.unreachable('pg_sleep(5) answered after its caller hung up'),
      (thrown: unknown) => thrown,
    );
    expect(performance.now() - aborted).toBeLessThan(200);
    expect(error).toMatchObject({ code: 'X_ABORTED' });
    const backend = await watcher.one<{ state: string }>(
      sql`select state from pg_stat_activity where pid = ${pid}`,
    );
    expect(backend?.state).toBe('idle');
    expect(await client.one<{ pid: number }>(sql`select pg_backend_pid() as pid`)).toEqual({ pid });
  });
});
