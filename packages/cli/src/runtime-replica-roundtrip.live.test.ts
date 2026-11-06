// Write, redirect, read against a real standby whose replay is PAUSED: the row the write committed
// is not on the standby, and the read the redirect leads to shows it anyway — the position cookie
// sent it to the primary. Needs `TEST_STANDBY_URL`; the test services have none, so it skips, named.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type PostgresClient,
  postgresClient,
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

    await standby.execute(raw('select pg_wal_replay_pause()'));
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
  });
});
