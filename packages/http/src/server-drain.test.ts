// The `accept` phase against a live socket: closing the listener must not wait on the sockets it
// already holds. Bun's `server.stop(false)` resolves only once every request AND websocket has
// closed, so awaiting it made one open browser tab stall the whole drain to its deadline.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  configureLifecycle,
  drain,
  drainExitCode,
  inflightCount,
  onShutdown,
  resetLifecycle,
  systemClock,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
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
  // A budget no test outlives: a drain that waited on the open socket would hang this test past
  // its timeout, so "not until the deadline" needs no stopwatch on a loaded runner.
  configureLifecycle({ deadlineMs: 600_000, readinessGraceMs: 0 });
  // The server's own view of the socket: its `close` handler is the event that says it is gone.
  let serverClosed = false;
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
      websocket: {
        open: () => undefined,
        message: () => undefined,
        close: () => {
          serverClosed = true;
        },
      },
    },
  }).start();
  const socket = await openSocket(`${handle.url().replace(/^http/, 'ws')}${SYNC_PATH}`);

  // Registered AFTER the server's own `accept` hook, so it runs only once that one has returned.
  let openAtLaterAccept: boolean | undefined;
  const unregister = onShutdown(
    'test:later-accept',
    () => {
      openAtLaterAccept = !serverClosed && socket.readyState === WebSocket.OPEN;
    },
    { phase: 'accept' },
  );
  try {
    await handle.stop();
  } finally {
    unregister();
    socket.close();
  }

  // It ran while the tab was still open: the server's accept hook did not wait for the socket.
  expect(openAtLaterAccept).toBe(true);
  // And the whole drain finished inside its budget: the body wait in the `inflight` phase counts
  // unfinished RESPONSES, and an upgraded socket is not one — counted, the open tab would stall the
  // drain one phase later, to the deadline this test never reaches.
  expect(drainExitCode()).toBe(0);
});

test('the control: a drain with nothing listening runs every accept hook and ends clean', async () => {
  // The control: with no socket at all the same hook runs and the drain ends inside its budget, so
  // the case above is about the socket and not about the lifecycle's own phases.
  configureLifecycle({ deadlineMs: 600_000, readinessGraceMs: 0 });
  let accepted = false;
  onShutdown(
    'test:later-accept',
    () => {
      accepted = true;
    },
    { phase: 'accept' },
  );
  await drain('manual');
  expect(accepted).toBe(true);
  expect(drainExitCode()).toBe(0);
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
  // The rest of the body is held until the drain has reached its `inflight` phase — an event, not a
  // sleep. Registered BEFORE the server starts, so it runs ahead of the server's own body wait in
  // the phase (hooks run in registration order), and it frees the body one loop turn later: the
  // body is provably unfinished as the drain reaches the point where it must wait for it, and a
  // drain that did not wait has already cut the socket by that turn.
  const rest = Promise.withResolvers<void>();
  onShutdown(
    'test:body-still-streaming',
    () => {
      setTimeout(rest.resolve, 0);
    },
    { phase: 'inflight' },
  );
  const handle = streamingServer(
    () =>
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('a'));
          await rest.promise;
          controller.enqueue(encoder.encode('b'));
          controller.close();
        },
      }),
  );
  const response = await fetch(`${handle.url()}/stream`);
  const reader = (response.body ?? expect.unreachable('no body')).getReader();
  const first = await reader.read();
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
  // A budget no test outlives: a drain that waited on the gone client's body would hang this test
  // past its timeout, so "at once" needs no stopwatch on a loaded runner.
  configureLifecycle({ deadlineMs: 600_000, readinessGraceMs: 0 });
  // Bun cancels the body's source when the client goes away: that is the event the drain hears.
  const cancelled = Promise.withResolvers<void>();
  const handle = streamingServer(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('x'));
        },
        // Never answers: a body that only ends because nobody is reading it any more.
        pull: () => new Promise<void>(() => undefined),
        cancel() {
          cancelled.resolve();
        },
      }),
  );
  const aborted = new AbortController();
  const response = await fetch(`${handle.url()}/stream`, { signal: aborted.signal });
  await (response.body ?? expect.unreachable('no body')).getReader().read();
  aborted.abort();
  await cancelled.promise;
  await handle.stop();
  expect(inflightCount()).toBe(0);
  expect(drainExitCode()).toBe(0);
});

test('a body that never ends is still bounded by the drain deadline', async () => {
  configureLifecycle({ deadlineMs: 400, readinessGraceMs: 0 });
  const handle = streamingServer(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: tick\n\n'));
        },
        // An open EventSource's body: it never closes, and nothing else ends it.
        pull: () => new Promise<void>(() => undefined),
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
  // It WAITED for the body — the whole budget, a lower bound a loaded runner can only overshoot
  // (less the 1 ms a timer may fire early by: the budget's own `setTimeout`, measured 399.8) — and
  // then the close hook cut it: the test reaching this line at all is the upper bound.
  expect(systemClock.monotonic() - startedAt).toBeGreaterThanOrEqual(399);
});
