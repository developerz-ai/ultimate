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
import { resetLifecycle } from '@ultimat3/core';
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
