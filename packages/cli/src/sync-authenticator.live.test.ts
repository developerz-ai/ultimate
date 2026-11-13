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
  InProcessTransport,
  LiveQueryRegistry,
  listenSyncNode,
  RingChangeBuffer,
  SocketRegistry,
  type SyncNode,
  syncNode,
} from '@ultimat3/realtime/server';
import { advanceClock } from '@ultimat3/testing';
import { syncAuthenticator } from './sync-authenticator';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const BUILD_ID = 'build-1';

/**
 * The window is crossed with `advanceClock`, never by sleeping: the repo's test preload freezes
 * `Date`, so the grant's `expiresAt` and the sweep's `now` both read the frozen instant and a real
 * five-minute wait would prove nothing anyway. The sweep INTERVAL is the node's own `setInterval`
 * on the real clock, and the test never times it: it awaits the sweep's consequence — the close
 * frame, or the resolver asked again — so a slow runner takes longer, never a different verdict.
 * `MAX_CREDENTIAL_TTL_MS` itself is asserted in the unit twin.
 */
const TTL_MS = 60_000;
const SWEEP_MS = 20;

let sql: Bun.SQL;

/** How many times the app's resolver has been asked, and who waits for the next ask. */
let resolved = 0;
let askWaiters: { readonly at: number; readonly wake: () => void }[] = [];
const asked = (): void => {
  resolved += 1;
  const due = askWaiters.filter((waiter) => waiter.at <= resolved);
  askWaiters = askWaiters.filter((waiter) => waiter.at > resolved);
  // Woken a macrotask later, never inside the resolver: the grant this answer becomes is built in
  // the microtasks after it returns, and a test that moved the clock first would stamp it ahead.
  for (const waiter of due) setImmediate(waiter.wake);
};
/** Resolves once the resolver has been asked `count` times in all — each sweep asks once. */
const untilAsked = (count: number): Promise<void> =>
  resolved >= count
    ? Promise.resolve()
    : new Promise((wake) => {
        askWaiters.push({ at: count, wake });
      });

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
  resolved = 0;
  askWaiters = [];
  // The app's own resolver, reading the session table on every call — which is what makes a
  // deleted row a different answer rather than a cached one.
  configureAuthenticator(async (request) => {
    const sid = (request.header('cookie') ?? '').replace('sid=', '');
    const rows = await sql.unsafe('select sid from x_sync_sessions where sid = $1', [sid]);
    asked();
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
  return syncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: BUILD_ID,
    sockets,
    // The object under test, wired exactly as `role-sync.ts` wires it.
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

/**
 * The close frame the server sent. A socket the sweep never closes leaves this pending, and the
 * test's own timeout is the red verdict — no deadline of this file's to tune against a runner.
 */
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.addEventListener('close', (event: CloseEvent) => {
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
    const code = await closed(ws);
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
    let closeCode: number | null = null;
    // Set before this test's own `ws.close()`: only a close the node sent is a verdict.
    let ending = false;
    const revoked = closed(ws).then((code) => {
      closeCode = code;
      if (!ending) expect.unreachable(`a live credential's socket was closed with ${String(code)}`);
    });
    // Three windows, each crossed by hand and each awaited as the resolver's next ask: a sweep
    // re-decides a grant only once its window has passed, and the frozen clock moves only here.
    // The passes are serialised, so the third ask means the first two — verdicts included — are
    // done: a socket either of them revoked is already off this node's books.
    const before = resolved;
    for (let window = 1; window <= 3; window += 1) {
      advanceClock(TTL_MS + 1);
      // Raced against the close: a sweep that revoked a live grant asks nothing more, so the
      // close is the verdict, not the suite's timeout.
      await Promise.race([untilAsked(before + window), revoked]);
    }
    expect(sync.sockets.count).toBe(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(closeCode).toBe(null);

    ending = true;
    ws.close();
    await revoked;
    listener.stop();
    await sync.stop();
  });
});
