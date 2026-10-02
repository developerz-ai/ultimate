// The stored event bus inside a TRANSACTION, against a real server: the one place `now()` and
// the statement's own time differ, and the embedded database cannot show it — its clock is the
// test's frozen one. A bus handed a transaction's connection stamps what the statement saw, not
// when the transaction began. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresClient } from '@ultimat3/db';
import { createPostgresClient, raw } from '@ultimat3/db';
import type { PgExecutor } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { createPgEventBus } from './events-pg';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = 'x_jobs_events_live';
/** Long enough to tell from a round trip on a loaded machine; short enough to cost nothing. */
const HELD_MS = 200;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · the event bus in a transaction', () => {
  let admin: PostgresClient;
  let client: PostgresClient;

  beforeAll(async () => {
    admin = createPostgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = createPostgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('a publish late in a transaction is stamped when it ran, not when the transaction began', async () => {
    using connection = await client.reserve();
    const executor: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        connection.query<R>({ text, values }),
    };
    await executor.query('begin', []);
    try {
      const [began] = await executor.query<{ at: number | string }>(
        'select floor(extract(epoch from now()) * 1000)::bigint as at',
        [],
      );
      // Real time passes inside the transaction — the server's own, nothing in this process.
      await executor.query(`select pg_sleep(${HELD_MS / 1000})`, []);
      const bus = createPgEventBus({ executor });
      const asked = await bus.now();
      const event = await bus.publish('otp', { code: 1 }, { ttl: 60_000 });
      expect(asked).toBeGreaterThanOrEqual(Number(began?.at) + HELD_MS);
      expect(event.publishedAt).toBeGreaterThanOrEqual(asked);
      expect(event.expiresAt).toBe(event.publishedAt + 60_000);
      // A step that asked after the transaction began still sees what it published.
      expect((await bus.find('otp', undefined, asked))?.payload).toEqual({ code: 1 });
    } finally {
      await executor.query('rollback', []);
    }
  });
});
