// No sockets and no `fetch()` here on purpose: the repo's test preload seals the
// network, and `handle.fetch()` runs the identical pipeline in-process. The real
// listen path is covered by e2e/server.e2e.test.ts, which is opt-in.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureLifecycle,
  drain,
  drainDeadlineMs,
  inflightCount,
  lifecycleState,
  resetLifecycle,
  shutdownHookCount,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { memoryRateLimitStore, type RateLimitStore } from './rate-limit';
import { json, text } from './response';
import type { Route } from './router';
import { createServer } from './server';

describe('the drain budget', () => {
  // `configureLifecycle({ deadlineMs })` is what `X_SHUTDOWN_TIMEOUT`'s own `fix:` line tells an
  // operator to write. `createServer` then called `configureLifecycle` unconditionally with
  // `drainTimeoutMs`, which `defineHttpConfig` DEFAULTED to 15s — so the remedy was reverted by
  // the next line of boot, silently, in every process that serves web.
  test('an app-declared lifecycle deadline survives createServer', () => {
    configureLifecycle({ deadlineMs: 600_000 });
    createServer({
      routes: [],
      role: 'web',
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0 }),
    });
    expect(drainDeadlineMs()).toBe(600_000);
  });

  test('declaring http.drainTimeoutMs IS declaring the budget, and it still wins', () => {
    configureLifecycle({ deadlineMs: 600_000 });
    createServer({
      routes: [],
      role: 'web',
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0, drainTimeoutMs: 5_000 }),
    });
    expect(drainDeadlineMs()).toBe(5_000);
  });
});

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
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      port: 0,
      hostname: '127.0.0.1',
      dev: false,
    }),
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

/**
 * A limit configured once must be enforced once, not once per process. Two handles stand in for
 * two replicas of one deployment: `docker/helm/values.yaml` ships `roles.web.replicas: 3`, and the
 * limiter's counters live in the process — so a limiter each replica keeps to itself multiplies
 * every configured number by the replica count and nothing says so.
 */
describe('rate limiting across replicas', () => {
  /** The memory store held by both handles: one process standing in for a shared tier. */
  const sharedStore = (): RateLimitStore => {
    const backing = memoryRateLimitStore();
    return { scope: 'shared', take: backing.take, reset: backing.reset };
  };

  const replica = (store: RateLimitStore) =>
    createServer({
      routes,
      role: 'web',
      config: defineHttpConfig({
        port: 0,
        dev: false,
        rateLimit: {
          enabled: true,
          scope: 'shared',
          defaultBucket: 'default',
          // No refill: the burst is the whole allowance, so a second one is unmistakable.
          buckets: { default: { capacity: 3, refillPerSecond: 0 } },
        },
      }),
      rateLimitStore: store,
    });

  test('two replicas behind one store spend a single burst between them', async () => {
    const store = sharedStore();
    const a = replica(store);
    const b = replica(store);
    const statuses: number[] = [];
    for (const handle of [a, b, a, b]) {
      statuses.push((await handle.fetch(new Request('http://local/ping'))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  test('a shared declaration on a per-process store refuses at boot, not at the first burst', () => {
    expect(() => replica(memoryRateLimitStore())).toThrow(/X_RATE_LIMIT_NOT_SHARED/);
  });

  test('the default declaration still boots on the memory store', () => {
    expect(() =>
      createServer({
        routes,
        role: 'web',
        config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0 }),
      }),
    ).not.toThrow();
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

  /**
   * One process, one lifecycle. A second `start()` after a drain used to bind a real port and then
   * answer 503 to everything forever — measured: the socket was still accepting connections after
   * that second handle's own `stop()` returned, because `drain()` had memoized on the first drain
   * and the close hook never ran again.
   *
   * No socket is bound by any of this, and that is the assertion: the refusal has to arrive BEFORE
   * `Bun.serve`, or the port is taken by the very handle that cannot serve from it.
   */
  test('start() after a drain is refused before any socket is bound', async () => {
    await drain('manual');
    const hooksBefore = shutdownHookCount();
    const handle = server();
    // Core's state, read through the handle — this package keeps no second copy to disagree with.
    expect(handle.state()).toBe('stopped');

    expect(() => handle.start()).toThrow(/X_LIFECYCLE_DRAINED/);

    // `url()` still refusing is what proves nothing was bound: `start()` assigns the server before
    // it registers anything, so a refusal raised after `Bun.serve` would leave a real origin here.
    expect(() => handle.url()).toThrow(/X_SERVER_NOT_STARTED|start\(\)/);
    // And nothing was left behind for the next drain to call against a torn-down handle.
    expect(shutdownHookCount()).toBe(hooksBefore);
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
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0, dev: false }),
    });
    const before = inflightCount();
    const response = await handle.fetch(new Request('http://local/boom'));
    expect(response.status).toBe(500);
    expect(inflightCount()).toBe(before);
  });
});
