// The `accept` phase against a live socket: closing the listener must not wait on the sockets it
// already holds. Bun's `server.stop(false)` resolves only once every request AND websocket has
// closed, so awaiting it made one open browser tab stall the whole drain to its deadline.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  configureLifecycle,
  drain,
  inflightCount,
  onShutdown,
  resetLifecycle,
  systemClock,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { memoryRateLimitStore } from './rate-limit';
import { installedRateLimitStore, resetRateLimitStore } from './rate-limit-installed';
import type { Route } from './router';
import { httpServer, type UpgradeTarget } from './server';

beforeEach(resetLifecycle);
afterEach(resetLifecycle);

const SYNC_PATH = '/_x/sync';

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', () => reject(socket));
  });

test('an open websocket does not hold a later accept hook until the drain deadline', async () => {
  configureLifecycle({ deadlineMs: 3000, readinessGraceMs: 0 });
  const handle = httpServer({
    routes: [],
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0 }),
    websocket: {
      path: SYNC_PATH,
      fetch: (request: Request, server: UpgradeTarget) =>
        server.upgrade(request, { data: {} })
          ? undefined
          : new Response('upgrade refused', { status: 426 }),
      websocket: { open: () => undefined, message: () => undefined, close: () => undefined },
    },
  }).start();
  const socket = await openSocket(`${handle.url().replace(/^http/, 'ws')}${SYNC_PATH}`);

  // Registered AFTER the server's own `accept` hook, so it runs only once that one has returned.
  let laterAcceptAt: number | undefined;
  const unregister = onShutdown(
    'test:later-accept',
    () => {
      laterAcceptAt = systemClock.monotonic();
    },
    { phase: 'accept' },
  );
  const startedAt = systemClock.monotonic();
  try {
    await handle.stop();
  } finally {
    unregister();
    socket.close();
  }

  expect(laterAcceptAt).toBeDefined();
  expect((laterAcceptAt ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(100);
  // And the whole drain: the body wait in the `inflight` phase counts unfinished RESPONSES, and an
  // upgraded socket is not one — counted, the open tab would stall the drain one phase later.
  expect(systemClock.monotonic() - startedAt).toBeLessThan(500);
});

test('the rate-limit store adopted at boot is still given back by a stop over an open socket', async () => {
  // 1b's release must survive the accept hook no longer awaiting the listener: `stop()` is what
  // gives it back, and it has to keep doing so when a socket is still open at drain time.
  resetRateLimitStore();
  configureLifecycle({ deadlineMs: 3000, readinessGraceMs: 0 });
  const store = memoryRateLimitStore();
  const handle = httpServer({
    routes: [],
    role: 'web',
    rateLimitStore: store,
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0 }),
    websocket: {
      path: SYNC_PATH,
      fetch: (request: Request, server: UpgradeTarget) =>
        server.upgrade(request, { data: {} }) ? undefined : new Response(null, { status: 426 }),
      websocket: { open: () => undefined, message: () => undefined, close: () => undefined },
    },
  }).start();
  expect(installedRateLimitStore()).toBe(store);
  const socket = await openSocket(`${handle.url().replace(/^http/, 'ws')}${SYNC_PATH}`);
  try {
    await handle.stop();
  } finally {
    socket.close();
  }
  const after = installedRateLimitStore();
  resetRateLimitStore();
  expect(after).not.toBe(store);
});

test('the control: a drain with nothing listening returns inside the same bound', async () => {
  // The control: with nothing listening, `drain()` returns well inside the budget, so the bound
  // above is about the socket and not about the lifecycle's own overhead.
  configureLifecycle({ deadlineMs: 3000, readinessGraceMs: 0 });
  const startedAt = systemClock.monotonic();
  await drain('manual');
  expect(systemClock.monotonic() - startedAt).toBeLessThan(100);
});

const encoder = new TextEncoder();

/** One public GET whose body is the stream `body()` builds — a page render, a file, an LLM stream. */
const streaming = (body: () => ReadableStream<Uint8Array>): Route[] => [
  {
    method: 'GET',
    path: '/stream',
    meta: { name: 'stream', auth: 'public' },
    handler: () => new Response(body()),
  },
];

const streamingServer = (body: () => ReadableStream<Uint8Array>) =>
  httpServer({
    routes: streaming(body),
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, port: 0, dev: false }),
  }).start();

/**
 * The handler RETURNS its Response before its body is written, so the request's own in-flight
 * count has ended by then. With the `accept` hook no longer waiting on the listener, nothing
 * waited for the body: the drain saw an idle process and `stop(true)` cut the socket mid-stream.
 */
test('a body still streaming when the drain starts is written to the end', async () => {
  configureLifecycle({ deadlineMs: 3000, readinessGraceMs: 0 });
  const handle = streamingServer(
    () =>
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('a'));
          await Bun.sleep(300);
          controller.enqueue(encoder.encode('b'));
          controller.close();
        },
      }),
  );
  const response = await fetch(`${handle.url()}/stream`);
  const reader = (response.body ?? expect.unreachable('no body')).getReader();
  const first = await reader.read();
  await Bun.sleep(20);
  const stopping = handle.stop();
  let text = new TextDecoder().decode(first.value);
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      text += new TextDecoder().decode(chunk.value);
    }
  } catch (error) {
    text += ` <${error instanceof Error ? error.message : 'read failed'}>`;
  }
  await stopping;
  expect(text).toBe('ab');
});

test('a client that goes away mid-body releases the drain at once', async () => {
  configureLifecycle({ deadlineMs: 3000, readinessGraceMs: 0 });
  const handle = streamingServer(
    () =>
      new ReadableStream({
        async pull(controller) {
          await Bun.sleep(20);
          controller.enqueue(encoder.encode('x'));
        },
      }),
  );
  const aborted = new AbortController();
  const response = await fetch(`${handle.url()}/stream`, { signal: aborted.signal });
  await (response.body ?? expect.unreachable('no body')).getReader().read();
  aborted.abort();
  await Bun.sleep(50);
  const startedAt = systemClock.monotonic();
  await handle.stop();
  expect(systemClock.monotonic() - startedAt).toBeLessThan(500);
  expect(inflightCount()).toBe(0);
});

test('a body that never ends is still bounded by the drain deadline', async () => {
  configureLifecycle({ deadlineMs: 400, readinessGraceMs: 0 });
  const handle = streamingServer(
    () =>
      new ReadableStream({
        async pull(controller) {
          await Bun.sleep(20);
          controller.enqueue(encoder.encode('event: tick\n\n'));
        },
      }),
  );
  const aborted = new AbortController();
  const response = await fetch(`${handle.url()}/stream`, { signal: aborted.signal });
  const reader = (response.body ?? expect.unreachable('no body')).getReader();
  await reader.read();
  // Kept reading, as an open EventSource does, so the server always has somewhere to write.
  void (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      // The socket closing under the reader is the end of this stream, and the point of the test.
    }
  })();
  const startedAt = systemClock.monotonic();
  await handle.stop();
  aborted.abort();
  expect(systemClock.monotonic() - startedAt).toBeLessThan(1500);
});
