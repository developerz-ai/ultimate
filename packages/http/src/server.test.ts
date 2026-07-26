// No sockets and no `fetch()` here on purpose: the repo's test preload seals the
// network, and `handle.fetch()` runs the identical pipeline in-process. The real
// listen path is covered by e2e/server.e2e.test.ts, which is opt-in.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { inflightCount, lifecycleState, resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { json, text } from './response';
import type { Route } from './router';
import { createServer } from './server';

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

const server = () =>
  createServer({
    routes,
    role: 'web',
    // start() is never called here, so no port is bound.
    config: defineHttpConfig({ port: 0, hostname: '127.0.0.1', dev: false }),
  });

// Core's lifecycle is a process singleton, so each test starts from `starting`.
beforeEach(resetLifecycle);
afterEach(resetLifecycle);

describe('createServer', () => {
  test('runs a static route through the full pipeline in-process', async () => {
    const response = await server().fetch(new Request('http://local/ping'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pong');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  test('extracts params via the fallback matcher', async () => {
    const response = await server().fetch(new Request('http://local/posts/42'));
    expect(await response.json()).toEqual({ id: '42' });
  });

  test('an unknown path is problem+json from the same pipeline', async () => {
    const response = await server().fetch(new Request('http://local/nope'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('X_ROUTE_NOT_FOUND');
  });

  test('url() before start() is a typed error, never undefined', () => {
    expect(() => server().url()).toThrow(/X_SERVER_NOT_STARTED|start\(\)/);
  });

  test('describe() feeds the manifest deterministically', () => {
    expect(
      server()
        .describe()
        .map((route) => route.name),
    ).toEqual(['ping', 'posts.show']);
  });
});

describe('lifecycle wiring', () => {
  test('state() reports core lifecycle state, not a private copy', () => {
    const handle = server();
    expect(handle.state()).toBe(lifecycleState());
    expect(handle.state()).toBe('starting');
  });

  test('in-flight requests are registered with core so a drain can wait for them', async () => {
    // beginWork()/done() must balance: a leak here would hang every deploy at the
    // `inflight` phase until the deadline expires.
    const before = inflightCount();
    await server().fetch(new Request('http://local/ping'));
    expect(inflightCount()).toBe(before);
  });

  test('a handler that throws still balances the in-flight count', async () => {
    const handle = createServer({
      routes: [
        {
          method: 'GET',
          path: '/boom',
          meta: { name: 'boom', auth: 'public' },
          handler: () => {
            throw new TypeError('handler exploded');
          },
        },
      ],
      role: 'web',
      config: defineHttpConfig({ port: 0, dev: false }),
    });
    const before = inflightCount();
    const response = await handle.fetch(new Request('http://local/boom'));
    expect(response.status).toBe(500);
    expect(inflightCount()).toBe(before);
  });
});
