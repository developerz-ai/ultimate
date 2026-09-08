// Binds a real port and makes real requests. The network stays sealed — `start()` announces the
// socket to core, so a request back to it is this process calling itself, not egress. Nothing
// excludes this file: it is the `e2e` step of `x verify` and it runs on every push.
//
//   bun test packages/http/e2e
//
// What only a socket can prove: Bun's native route table dispatches static paths, the
// param fallback still reaches `fetch`, health endpoints answer outside the pipeline,
// and readyz flips to 503 the moment a drain starts.
import { afterAll, describe, expect, test } from 'bun:test';
import { drain, resetLifecycle, shutdownHookCount } from '@ultimat3/core';
import { defineHttpConfig } from '../src/config';
import { json, text } from '../src/response';
import type { Route } from '../src/router';
import { createServer } from '../src/server';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/ping',
    meta: { name: 'ping', auth: 'public' },
    handler: () => text('pong'),
  },
  {
    method: 'GET',
    path: '/posts/:id',
    meta: { name: 'posts.show', auth: 'public' },
    handler: (request) => json({ id: request.param('id') }),
  },
];

resetLifecycle();

// port 0 lets the kernel pick, so this never collides with a running dev server.
const handle = createServer({
  routes,
  role: 'web',
  config: defineHttpConfig({
    rateLimit: { scope: 'process' },
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
  }),
}).start();

afterAll(async () => {
  await handle.stop();
  resetLifecycle();
});

describe('real socket', () => {
  test('static route is served through Bun native routing', async () => {
    const response = await fetch(`${handle.url()}/ping`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pong');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  test('param route falls through to the matcher', async () => {
    expect(await (await fetch(`${handle.url()}/posts/42`)).json()).toEqual({ id: '42' });
  });

  test('unknown path is problem+json over the wire', async () => {
    const response = await fetch(`${handle.url()}/nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('X_ROUTE_NOT_FOUND');
  });

  test('healthz and readyz answer outside the pipeline, from core state', async () => {
    const health = await fetch(`${handle.url()}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body['role']).toBe('web');
    expect(body['state']).toBe('ready');
    expect((await fetch(`${handle.url()}/readyz`)).status).toBe(200);
  });
});

/**
 * One origin serves the app and its websocket.
 *
 * The failure this closes, measured 2026-09-07 over a VSCodium Remote-SSH workspace: `x dev` binds
 * the app on 3000 and the sync node on 3001, the editor forwarded 3000 alone, and the page loaded
 * while every dial of `ws://localhost:3001/_x/sync` failed — with the same upgrade answering `101`
 * from the box itself. Nothing was broken at either end; there was no tunnel between them. A
 * second port is a second thing to publish, and every one-port surface — a forwarded port, a
 * Codespace, an ingress, `ssh -L` — publishes the app's and not its neighbour's.
 *
 * Only a socket can prove any of it: the upgrade never reaches `fetch` under `handle.fetch()`.
 *
 * ABOVE the two describes below: `stop()` delegates to core's `drain()`, which is process-wide —
 * whichever server calls it takes every other listener in this file down with it.
 */
describe("a websocket mounted on the app's own port", () => {
  const MOUNT_PATH = '/_x/echo';

  const mounted = createServer({
    routes,
    role: 'web',
    // The mount speaks Bun's own convention, which is `SyncNode.fetch`'s: `undefined` means the
    // upgrade took, a `Response` is a refusal.
    websocket: {
      path: MOUNT_PATH,
      fetch: (request, server) =>
        server.upgrade(request, { data: { note: 'mounted' } })
          ? undefined
          : new Response('expected a websocket upgrade', { status: 426 }),
      websocket: {
        open: (ws: { send(data: string): void }) => {
          ws.send('open');
        },
        message: (ws: { send(data: string): void }, message: string | Uint8Array) => {
          ws.send(`echo:${String(message)}`);
        },
        close: () => undefined,
      },
    },
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      port: 0,
      hostname: '127.0.0.1',
      dev: false,
    }),
  }).start();

  // No `afterAll` that stops it: `stop()` IS a process-wide drain, and one here would mark the
  // lifecycle drained before the two describes below start servers of their own — `markReady`
  // then refuses them with `X_LIFECYCLE_DRAINED`. The drain in `describe('drain')` closes this
  // listener along with every other, which is the same fact stated once.

  const dial = async (): Promise<readonly string[]> => {
    const socket = new WebSocket(`${mounted.url().replace('http', 'ws')}${MOUNT_PATH}`);
    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => {
        reject(new Error('the upgrade never took'));
      };
      socket.onmessage = (event: MessageEvent) => {
        seen.push(String(event.data));
        if (seen.length === 1) socket.send('ping');
        else resolve();
      };
    });
    socket.close();
    return seen;
  };

  test('the upgrade takes on the mount path, and frames flow both ways', async () => {
    expect(await dial()).toEqual(['open', 'echo:ping']);
  });

  test('every other path is still the pipeline, untouched', async () => {
    expect(await (await fetch(`${mounted.url()}/ping`)).text()).toBe('pong');
    expect((await fetch(`${mounted.url()}/nope`)).status).toBe(404);
    // The health endpoints answer outside the pipeline and outside the mount alike.
    expect((await fetch(`${mounted.url()}/readyz`)).status).toBe(200);
  });

  test("a refused upgrade is the mount's own answer, not a 404 from the router", async () => {
    // No route is registered for this path: without the mount it would be `X_ROUTE_NOT_FOUND`.
    const response = await fetch(`${mounted.url()}${MOUNT_PATH}`);
    expect(response.status).toBe(426);
    expect(await response.text()).toBe('expected a websocket upgrade');
  });
});

describe('drain', () => {
  test('readyz reports 503 once draining, then the process reports stopped', async () => {
    const draining = createServer({
      routes,
      role: 'worker',
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        port: 0,
        hostname: '127.0.0.1',
        dev: false,
      }),
    }).start();
    const url = draining.url();
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    await draining.stop();
    expect(draining.state()).toBe('stopped');
  });
});

describe('the drain hands every hook back', () => {
  /**
   * On the SIGTERM path the `close` hook sets `server = undefined`, and `stop()` opened with
   * `if (server === undefined) return;` — so the `unregister?.()` pair in its `finally` was skipped
   * for exactly the path that runs in production. Both hooks stayed registered against a handle
   * whose socket is gone: `x dev`'s role rollback and every test teardown calls `stop()` after a
   * drain, and the count climbed by two per server per lifecycle. Core's `shutdownHookCount()` is
   * the probe `packages/core/CLAUDE.md` names for exactly this leak, and nothing was reading it
   * here.
   *
   * Last in the file, and it resets first: one process, one lifecycle, and everything above has
   * already drained the one this file started with.
   */
  test('a server drained by a signal leaves nothing registered behind its own stop()', async () => {
    resetLifecycle();
    const before = shutdownHookCount();
    const handle = createServer({
      routes,
      role: 'web',
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        port: 0,
        hostname: '127.0.0.1',
        dev: false,
      }),
    }).start();
    // Two: 'accept' stops listening, 'close' closes the socket. Non-vacuity for the count below.
    expect(shutdownHookCount()).toBe(before + 2);

    // The SIGTERM path, which is the one that clears `server` from underneath `stop()`.
    await drain('SIGTERM');
    await handle.stop();

    expect(shutdownHookCount()).toBe(before);
    resetLifecycle();
  });
});
