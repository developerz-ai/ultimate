// `websocket:` as a LIST: every mount served on the one listener, each upgrade routed to the mount
// owning its path and every frame back to it, every path refused when a declaration already answers
// it — over real sockets, because Bun's native route table is the thing that would shadow a mount.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError, resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { textResponse } from './response';
import type { Route } from './router';
import { httpServer, type ServerHandle, type UpgradeTarget, type WebSocketMount } from './server';

beforeEach(resetLifecycle);
afterEach(resetLifecycle);

const ping: Route = {
  method: 'GET',
  path: '/ping',
  meta: { name: 'ping', auth: 'public' },
  handler: () => textResponse('pong'),
};

interface EchoWs {
  readonly data: { readonly path: string };
  send(message: string): void;
}

/** A mount that answers every message with its own path, so a frame says which mount took it. */
const echo = (path: string): WebSocketMount<EchoWs> => ({
  path,
  fetch: (request: Request, server: UpgradeTarget) =>
    server.upgrade(request, { data: { path } }) ? undefined : new Response(null, { status: 426 }),
  websocket: {
    open: () => undefined,
    message: (ws, message) => ws.send(`${ws.data.path}:${String(message)}`),
    close: () => undefined,
  },
});

const serve = (websocket: WebSocketMount | readonly WebSocketMount[], routes = [ping]) =>
  httpServer({
    routes,
    role: 'web',
    websocket,
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0, hostname: '127.0.0.1' }),
  });

/** One round trip on a fresh socket: what the mount at `path` answered to `hello`. */
const roundTrip = (handle: ServerHandle, path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${handle.url().replace(/^http/, 'ws')}${path}`);
    socket.addEventListener('open', () => socket.send('hello'));
    socket.addEventListener('message', (event) => {
      socket.close();
      resolve(String(event.data));
    });
    socket.addEventListener('error', reject);
  });

const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
  return expect.unreachable('the server was built');
};

describe('unit · httpServer serves a list of websocket mounts', () => {
  test('each path reaches its own mount, and every other path the pipeline', async () => {
    const handle = serve([echo('/_x/sync'), echo('/link')]).start();
    try {
      expect(await roundTrip(handle, '/link')).toBe('/link:hello');
      expect(await roundTrip(handle, '/_x/sync')).toBe('/_x/sync:hello');
      expect(await (await fetch(`${handle.url()}/ping`)).text()).toBe('pong');
    } finally {
      await handle.stop();
    }
  });

  test('one mount, bare or in a list, is served the same way', async () => {
    for (const option of [echo('/link'), [echo('/link')]]) {
      resetLifecycle();
      const handle = serve(option).start();
      try {
        expect(await roundTrip(handle, '/link')).toBe('/link:hello');
      } finally {
        await handle.stop();
      }
    }
  });

  test('an empty list opens no websocket, and the pipeline answers every path', async () => {
    const handle = serve([]).start();
    try {
      expect((await fetch(`${handle.url()}/link`)).status).toBe(404);
      expect(await (await fetch(`${handle.url()}/ping`)).text()).toBe('pong');
    } finally {
      await handle.stop();
    }
  });

  test('EVERY path is checked free: the second mount on a route is refused, not shadowed', () => {
    expect(codeOf(() => serve([echo('/_x/sync'), echo('/ping')]))).toBe('X_ROUTE_CONFLICT');
    expect(codeOf(() => serve([echo('/link'), echo('/readyz')]))).toBe('X_ROUTE_CONFLICT');
  });

  test('two mounts at one path are refused at construction', () => {
    expect(codeOf(() => serve([echo('/link'), echo('/link')]))).toBe('X_INVARIANT');
  });
});
