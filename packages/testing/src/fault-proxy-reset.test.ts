// The fault proxy when the far side cuts hard: a real service that resets its connection mid-
// stream takes the client's connection with it, and so does a client that resets — the pair is
// gone from `open` either way, never left half-open.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import type { FaultProxy } from './fault-proxy';
import { faultProxy } from './fault-proxy';

const opened: { stop?: () => void; proxy?: FaultProxy } = {};
afterEach(() => {
  opened.proxy?.close();
  opened.stop?.();
  delete opened.proxy;
  delete opened.stop;
});

/** A service that answers its first byte by resetting the connection (RST, not FIN). */
const resettingServer = () => {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        socket.terminate();
      },
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
};

const dialClosed = async (
  port: number,
): Promise<{ socket: Socket<undefined>; closed: Promise<void> }> => {
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data() {},
      close: () => closed.resolve(),
      error: () => closed.resolve(),
    },
  });
  return { socket, closed: closed.promise };
};

const settled = async (proxy: FaultProxy): Promise<void> => {
  while (proxy.counts().open > 0) await new Promise((resolve) => setImmediate(resolve));
};

describe('faultProxy when a side resets', () => {
  test('a service that resets mid-stream closes the client, and the pair is gone', async () => {
    const server = resettingServer();
    opened.stop = server.stop;
    const proxy = await faultProxy({ target: { hostname: '127.0.0.1', port: server.port } });
    opened.proxy = proxy;
    const client = await dialClosed(proxy.port);
    client.socket.write('x');
    await client.closed;
    await settled(proxy);
    expect(proxy.counts()).toMatchObject({ accepted: 1, open: 0, upstreamFailed: 0 });
  });

  test('a client that resets takes the upstream leg down with it', async () => {
    const upstreamClosed = Promise.withResolvers<void>();
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data() {},
        close: () => upstreamClosed.resolve(),
        error: () => upstreamClosed.resolve(),
      },
    });
    opened.stop = () => listener.stop(true);
    const proxy = await faultProxy({ target: { hostname: '127.0.0.1', port: listener.port } });
    opened.proxy = proxy;
    const client = await dialClosed(proxy.port);
    client.socket.write('hello');
    while (proxy.counts().bytesUp < 5) await new Promise((resolve) => setImmediate(resolve));
    client.socket.terminate();
    await upstreamClosed.promise;
    await settled(proxy);
    expect(proxy.counts().open).toBe(0);
  });
});
