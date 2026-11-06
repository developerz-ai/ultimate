// Write, redirect, read against a real standby whose replay is PAUSED: the row the write committed
// is not on the standby, and the read the redirect leads to shows it anyway — the position cookie
// sent it to the primary. Needs `TEST_STANDBY_URL` (the test services' `postgres-standby`); unset,
// it skips, named.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type DbClient,
  type PostgresClient,
  parsePosition,
  postgresClient,
  primaryPosition,
  REPLICA_URL_ENV,
  raw,
  replicatedClient,
  setDbClient,
  sql,
} from '@ultimat3/db';
import { defineHttpConfig, httpServer, type Route } from '@ultimat3/http';
import type { ServiceBinding } from './runtime-bindings';
import { replicaMiddleware } from './runtime-replica';
import { POSITION_COOKIE } from './runtime-replica-position';

const url = Bun.env['TEST_DATABASE_URL'];
const standbyUrl = Bun.env['TEST_STANDBY_URL'];
// A physical standby streaming from TEST_DATABASE_URL, with a superuser for `pg_wal_replay_pause()`.
const hasStandby =
  typeof url === 'string' &&
  url.length > 0 &&
  typeof standbyUrl === 'string' &&
  standbyUrl.length > 0;

const ORIGIN = 'http://app.test';
const TABLE = 'x_roundtrip_live';
const STANDBY_LIMIT_MS = 5_000;

/** Polls `standby` until `ready` answers true. The standby replays WAL in its own process. */
async function untilStandby(what: string, ready: () => Promise<boolean>): Promise<void> {
  const started = performance.now();
  while (!(await ready())) {
    if (performance.now() - started > STANDBY_LIMIT_MS) {
      expect.unreachable(`the standby did not ${what} within ${String(STANDBY_LIMIT_MS)} ms`);
    }
    // real-clock: the standby's startup process replays and pauses on its own schedule
    await Bun.sleep(20);
  }
}

/** Pause replay only once it has passed every WAL record the primary wrote so far. */
async function pauseAfterCatchingUp(primary: DbClient, standby: DbClient): Promise<void> {
  const written = (await primaryPosition(primary)) ?? 0n;
  await untilStandby('replay the primary', async () => {
    const row = await standby.one<{ lsn: string | null }>(
      sql`select pg_last_wal_replay_lsn()::text as lsn`,
    );
    return (parsePosition(row?.lsn) ?? 0n) >= written;
  });
  await standby.execute(raw('select pg_wal_replay_pause()'));
  // `pg_wal_replay_pause()` only REQUESTS the pause; a record replayed after it returns would
  // land the very row this test needs the standby not to have.
  await untilStandby('pause replay', async () => {
    const row = await standby.one<{ state: string }>(
      sql`select pg_get_wal_replay_pause_state()::text as state`,
    );
    return row?.state === 'paused';
  });
}

describe.skipIf(!hasStandby)('live · standby · write, redirect, read with replay paused', () => {
  let primary: PostgresClient;
  let standby: PostgresClient;

  beforeAll(async () => {
    primary = postgresClient({ url: url ?? '', role: 'web', profile: { max: 2 } });
    standby = postgresClient({ url: standbyUrl ?? '', role: 'web', profile: { max: 2 } });
    await primary.execute(raw(`create table if not exists ${TABLE} (id text primary key)`));
  });

  afterAll(async () => {
    await standby.execute(raw('select pg_wal_replay_resume()')).catch(() => undefined);
    await primary.execute(raw(`drop table if exists ${TABLE}`));
    setDbClient(undefined);
    await primary.close();
    await standby.close();
  });

  test('the redirected read shows the row the paused standby has not replayed', async () => {
    const client = replicatedClient(primary, standby, { positionCacheMs: 0 });
    setDbClient(client);
    const id = crypto.randomUUID();
    const routes: Route[] = [
      {
        method: 'POST',
        path: '/rows',
        meta: { name: 'createRow', auth: 'public' },
        handler: async () => {
          await client.execute(sql`insert into ${raw(TABLE)} (id) values (${id})`);
          return Response.redirect(`${ORIGIN}/rows/latest`, 303);
        },
      },
      {
        method: 'GET',
        path: '/rows/latest',
        meta: { name: 'readRow', auth: 'public' },
        handler: async () =>
          Response.json(await client.query(sql`select id from ${raw(TABLE)} where id = ${id}`)),
      },
    ];
    const binding: ServiceBinding = {
      name: 'db',
      mode: 'external',
      url: url ?? '',
      detail: 'live',
    };
    const server = httpServer({
      routes,
      middleware: replicaMiddleware(binding, { [REPLICA_URL_ENV]: standbyUrl }),
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });

    // The CREATE TABLE must be on the standby before it pauses: paused short of it, the
    // non-vacuity read below is X_DB_SCHEMA_STALE, not an empty answer.
    await pauseAfterCatchingUp(primary, standby);
    const wrote = await server.fetch(
      new Request(`${ORIGIN}/rows`, { method: 'POST', headers: { origin: ORIGIN } }),
    );
    expect(wrote.status).toBe(303);
    const cookie =
      wrote.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${POSITION_COOKIE}=`))
        ?.split(';')[0] ?? '';
    expect(cookie).not.toBe('');

    // Non-vacuity: the standby really does not have the row while replay is paused.
    expect(await standby.query(sql`select id from ${raw(TABLE)} where id = ${id}`)).toEqual([]);

    const read = await server.fetch(new Request(`${ORIGIN}/rows/latest`, { headers: { cookie } }));
    expect(await read.json()).toEqual([{ id }]);
    expect(client.stats.replica).toBe(0);
  }, 15_000);
});
