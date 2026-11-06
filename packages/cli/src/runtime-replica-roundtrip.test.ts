// Write, redirect, read — through the runtime, not the stage alone: the middleware the boot lays in
// (`replicaMiddleware`), a real `httpServer`, and the browser's half done by hand: the `Set-Cookie`
// off the 303 sent back as `Cookie`. Over two recording clients, so each claim is which NODE read.

import { afterEach, describe, expect, test } from 'bun:test';
import { REPLICA_URL_ENV, recordingClient, replicatedClient, setDbClient, sql } from '@ultimat3/db';
import { defineHttpConfig, httpServer, type Route } from '@ultimat3/http';
import type { ServiceBinding } from './runtime-bindings';
import { replicaMiddleware } from './runtime-replica';
import { POSITION_COOKIE } from './runtime-replica-position';

const BINDING: ServiceBinding = {
  name: 'db',
  mode: 'external',
  url: 'postgres://primary.test/app',
  detail: 'external',
};
const ENV = { [REPLICA_URL_ENV]: 'postgres://standby.test/app' };
const ORIGIN = 'http://app.test';
const READ = 'select * from posts';

function cluster() {
  const primary = recordingClient().on(/pg_current_wal_lsn/, { rows: [{ lsn: '0/AB' }] });
  // Paused: replay stands at 0/10, behind the write's 0/AB.
  const standby = recordingClient().on(/pg_last_wal_replay_lsn/, { rows: [{ lsn: '0/10' }] });
  const client = replicatedClient(primary, standby, { positionCacheMs: 0 });
  setDbClient(client);
  const routes: Route[] = [
    {
      method: 'POST',
      path: '/posts',
      meta: { name: 'createPost', auth: 'public' },
      handler: async () => {
        await client.execute(sql`insert into posts (id) values (${'p1'})`);
        return Response.redirect(`${ORIGIN}/posts/p1`, 303);
      },
    },
    {
      method: 'GET',
      path: '/posts/p1',
      meta: { name: 'postById', auth: 'public' },
      handler: async () => Response.json(await client.query(sql`select * from posts`)),
    },
  ];
  const server = httpServer({
    routes,
    middleware: replicaMiddleware(BINDING, ENV),
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });
  const reads = () => ({
    primary: primary.texts.filter((text) => text.startsWith(READ)).length,
    standby: standby.texts.filter((text) => text.startsWith(READ)).length,
  });
  const resume = () => standby.on(/pg_last_wal_replay_lsn/, { rows: [{ lsn: '0/FF' }] });
  return { server, reads, resume };
}

/** The `name=value` a browser sends back for the position cookie the response set. */
function cookieOf(response: Response): string {
  const set = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${POSITION_COOKIE}=`));
  return set?.split(';')[0] ?? '';
}

afterEach(() => setDbClient(undefined));

describe('read-your-writes across a redirect, through the runtime', () => {
  test('the redirect carries the position, and the read it leads to waits for the standby', async () => {
    const { server, reads, resume } = cluster();
    const wrote = await server.fetch(
      new Request(`${ORIGIN}/posts`, { method: 'POST', headers: { origin: ORIGIN } }),
    );
    expect(wrote.status).toBe(303);
    expect(wrote.headers.get('location')).toBe(`${ORIGIN}/posts/p1`);
    const cookie = cookieOf(wrote);
    expect(cookie).toBe(`${POSITION_COOKIE}=0/AB`);

    const follow = () =>
      server.fetch(new Request(`${ORIGIN}/posts/p1`, { headers: { cookie, origin: ORIGIN } }));
    // The standby is paused behind the write: the row is read where it exists.
    expect((await follow()).status).toBe(200);
    expect(reads()).toEqual({ primary: 1, standby: 0 });

    // Replay resumed past it: the same cookie now lets the standby answer.
    resume();
    await follow();
    expect(reads()).toEqual({ primary: 1, standby: 1 });
  });

  test('without the cookie the same read is the standby’s — the cookie is what moved it', async () => {
    const { server, reads } = cluster();
    await server.fetch(new Request(`${ORIGIN}/posts/p1`));
    expect(reads()).toEqual({ primary: 0, standby: 1 });
  });
});
