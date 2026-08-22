// The revocation, end to end: a real websocket on a real `sync` node, a real session row in
// Postgres, and `logout` as the only thing that changes. The unit twin proves the grant's SHAPE
// and can prove nothing about the consequence — a grant with no `expiresAt` passed every unit
// assertion the adapter had while the socket it authorized stayed open forever.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file drops its
// table. Locally:
//
//   docker run -d --name x-sync -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/cli/src/sync-authenticator.live.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetListeners, userActor } from '@ultimat3/core';
import { configureAuthenticator, resetAuthenticator } from '@ultimat3/http';
import {
  ChannelHub,
  createSyncNode,
  InProcessTransport,
  LiveQueryRegistry,
  listenSyncNode,
  RingChangeBuffer,
  SocketRegistry,
  type SyncNode,
} from '@ultimat3/realtime/server';
import { advanceClock } from '@ultimat3/testing';
import { syncAuthenticator } from './sync-authenticator';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const BUILD_ID = 'build-1';

/**
 * The window is crossed with `advanceClock`, never by sleeping: the repo's test preload freezes
 * `Date`, so the grant's `expiresAt` and the sweep's `now` both read the frozen instant and a real
 * five-minute wait would prove nothing anyway. The sweep INTERVAL is a `setInterval`, which runs
 * on the real clock — so it is the one number here that is milliseconds of actual waiting.
 * `SYNC_GRANT_TTL_MS` itself is asserted in the unit twin.
 */
const TTL_MS = 60_000;
const SWEEP_MS = 20;

let sql: Bun.SQL;

beforeAll(async () => {
  if (url === undefined) return;
  sql = new Bun.SQL(url, { max: 2 });
  await sql.unsafe('drop table if exists x_sync_sessions', []);
  await sql.unsafe('create table x_sync_sessions (sid text primary key)', []);
});

afterAll(async () => {
  if (url === undefined) return;
  await sql.unsafe('drop table if exists x_sync_sessions', []);
  await sql.end();
});

beforeEach(async () => {
  if (url === undefined) return;
  await sql.unsafe('delete from x_sync_sessions', []);
  await sql.unsafe("insert into x_sync_sessions (sid) values ('abc')", []);
  // The app's own resolver, reading the session table on every call — which is what makes a
  // deleted row a different answer rather than a cached one.
  configureAuthenticator(async (request) => {
    const sid = (request.header('cookie') ?? '').replace('sid=', '');
    const rows = await sql.unsafe('select sid from x_sync_sessions where sid = $1', [sid]);
    return rows.length === 0 ? null : userActor({ id: 'u1', roles: ['member'] });
  });
});

afterEach(() => {
  resetAuthenticator();
  resetListeners();
});

function node(): SyncNode {
  const sockets = new SocketRegistry();
  const transport = new InProcessTransport();
  return createSyncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: BUILD_ID,
    sockets,
    // The object under test, wired exactly as `dev-sync.ts` wires it.
    authenticate: syncAuthenticator(BUILD_ID, { ttlMs: TTL_MS }) ?? expect.unreachable('no auth'),
    reauthenticateIntervalMs: SWEEP_MS,
  });
}

/**
 * Bun's `WebSocket` accepts `{ headers }`; `lib.dom`'s declaration — the one `tsc` reads here —
 * takes a protocol list in that position. The upgrade's cookie IS the subject of this file, so it
 * has to be on the wire; the constructor is renarrowed once rather than cast at each dial.
 */
type DialWithHeaders = new (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

const dial = WebSocket as unknown as DialWithHeaders;

/** Resolves on `open`, rejects on `error` — never hangs the suite waiting on a socket. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      resolve();
    });
    ws.addEventListener('error', () => {
      reject(new Error(`websocket did not open: ${ws.url}`));
    });
  });
}

/** The close frame the server sent, or `null` if it never sent one inside `withinMs`. */
function closedWithin(ws: WebSocket, withinMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, withinMs);
    ws.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event.code);
    });
  });
}

describeLive('a revoked session closes the socket it authorized', () => {
  test('deleting the session row closes the open websocket with 1008', async () => {
    const sync = node();
    await sync.start();
    const listener = listenSyncNode(sync, { port: 0 });
    const ws = new dial(`${listener.url}/_x/sync`, { headers: { cookie: 'sid=abc' } });
    await opened(ws);
    // The grant is recorded at the UPGRADE, before any frame — `onGranted` runs inside
    // `handleUpgrade` — so a connected socket is already an authorized one.
    expect(sync.sockets.count).toBe(1);

    // `logout` / `revokeSession` / `disableUser`, as far as this node can tell: the credential
    // that opened the socket has stopped resolving. Nothing else changes — no client action, no
    // frame, and the 15s heartbeat would keep the socket alive indefinitely.
    await sql.unsafe("delete from x_sync_sessions where sid = 'abc'", []);
    advanceClock(TTL_MS + 1);

    // Observed before the fix: `null` — no close at all, at any deadline, because a grant with no
    // `expiresAt` never enters `GrantBook.expired()` and the sweep has nothing to re-decide.
    const code = await closedWithin(ws, SWEEP_MS * 25);
    expect(code).toBe(1008);
    expect(sync.sockets.count).toBe(0);

    listener.stop();
    await sync.stop();
  });

  test('a session that is still there survives every sweep — refreshed, not revoked', async () => {
    const sync = node();
    await sync.start();
    const listener = listenSyncNode(sync, { port: 0 });
    const ws = new dial(`${listener.url}/_x/sync`, { headers: { cookie: 'sid=abc' } });
    await opened(ws);

    // The other direction of the same mechanism, and the one that makes it safe to ship: a window
    // that closed live sockets still holding a valid credential would be an outage the framework
    // caused. Several windows pass, with the row intact and every sweep re-deciding it.
    advanceClock(TTL_MS * 4);
    expect(await closedWithin(ws, SWEEP_MS * 25)).toBe(null);
    expect(sync.sockets.count).toBe(1);

    ws.close();
    listener.stop();
    await sync.stop();
  });
});
