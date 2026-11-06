// Write, redirect, read: the request that wrote answers with its WAL position, and the next request
// carrying it back reads the primary while the replica is behind it. Driven through db's own
// replicated client over two recording clients, so every claim is about which NODE answered — and
// through http's own pipeline, whose `response` stage is what lays the stamp onto the answer.

import { afterEach, describe, expect, test } from 'bun:test';
import { recordingClient, replicatedClient, setDbClient, sql } from '@ultimat3/db';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { POSITION_COOKIE, POSITION_HEADER, positionStage } from './runtime-replica-position';

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });

const requestWith = (headers: Readonly<Record<string, string>> = {}, cookie?: string) =>
  new Request('https://app.test/x', {
    headers:
      cookie === undefined ? headers : { ...headers, cookie: `${POSITION_COOKIE}=${cookie}` },
  });

function pair(replayed: string) {
  const primary = recordingClient().on(/pg_current_wal_lsn/, { rows: [{ lsn: '0/AB' }] });
  const replica = recordingClient().on(/pg_last_wal_replay_lsn/, { rows: [{ lsn: replayed }] });
  const client = replicatedClient(primary, replica, { positionCacheMs: 0 });
  setDbClient(client);
  const reads = () => ({
    primary: primary.texts.filter((text) => text.startsWith('select * from posts')).length,
    replica: replica.texts.filter((text) => text.startsWith('select * from posts')).length,
  });
  return { client, primary, reads };
}

const run = (request: Request, handler: () => Promise<Response>) =>
  httpPipeline({
    table: httpRouter([
      { method: 'GET', path: '/x', meta: { name: 'x', auth: 'public' }, handler: () => handler() },
    ]),
    config,
    middleware: [positionStage()],
  }).handle(request, { role: 'web' });

afterEach(() => setDbClient(undefined));

describe('the position a write produced', () => {
  test('a request that wrote answers the header and a __Host- cookie, even on a redirect', async () => {
    const { client } = pair('0/0');
    const response = await run(requestWith(), async () => {
      await client.execute(sql`insert into posts (id) values (${'p1'})`);
      return Response.redirect('https://app.test/posts/p1', 303);
    });
    expect(response.status).toBe(303);
    expect(response.headers.get(POSITION_HEADER)).toBe('0/AB');
    expect(response.headers.getSetCookie()).toEqual([
      `${POSITION_COOKIE}=0/AB; Max-Age=30; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
  });

  test('a request that only read sets nothing and asks the primary nothing', async () => {
    const { client, primary } = pair('0/0');
    const response = await run(requestWith(), async () => {
      await client.query(sql`select * from posts`);
      return new Response('ok');
    });
    expect(response.headers.get(POSITION_HEADER)).toBeNull();
    expect(primary.texts).toEqual([]);
  });
});

describe('the next request, carrying it', () => {
  test('a replica behind the cookie: the primary reads', async () => {
    const { client, reads } = pair('0/10');
    await run(requestWith({}, '0/AB'), async () => {
      await client.query(sql`select * from posts`);
      return new Response('ok');
    });
    expect(reads()).toEqual({ primary: 1, replica: 0 });
  });

  test('a replica past the header: the replica reads', async () => {
    const { client, reads } = pair('0/FF');
    await run(requestWith({ [POSITION_HEADER]: '0/AB' }), async () => {
      await client.query(sql`select * from posts`);
      return new Response('ok');
    });
    expect(reads()).toEqual({ primary: 0, replica: 1 });
  });

  test('a forged value is no position at all: parsed, never echoed', async () => {
    const { client, reads } = pair('0/0');
    const response = await run(requestWith({ [POSITION_HEADER]: '<script>' }), async () => {
      await client.query(sql`select * from posts`);
      return new Response('ok');
    });
    expect(reads()).toEqual({ primary: 0, replica: 1 });
    expect(response.headers.get(POSITION_HEADER)).toBeNull();
  });
});
