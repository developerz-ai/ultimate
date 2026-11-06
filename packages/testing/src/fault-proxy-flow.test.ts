// The fault proxy under backpressure and at its edges: a payload larger than a socket buffer
// crosses whole (the drain-driven flush), the default `delay` wait, a proxy born refusing, and the
// `mode` it reports.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import type { FaultProxy } from './fault-proxy';
import { faultProxy } from './fault-proxy';

/**
 * Past what the kernel's loopback buffers hold for a client that is not reading (~2.5 MB measured
 * on Linux), so the proxy's write to the client comes back short and the rest waits for `drain`.
 */
const PAYLOAD_BYTES = 6 * 1024 * 1024;

interface Upstream {
  readonly port: number;
  stop(): void;
}

/** A server that, on the first byte, answers `bytes` bytes — writing past its own backpressure. */
const floodServer = (bytes: number): Upstream => {
  const payload = new Uint8Array(bytes).fill(7);
  const pending = new Map<Socket<undefined>, Uint8Array>();
  const pump = (socket: Socket<undefined>): void => {
    const rest = pending.get(socket);
    if (rest === undefined) return;
    const written = socket.write(rest);
    if (written >= rest.length) pending.delete(socket);
    else pending.set(socket, rest.subarray(Math.max(0, written)));
  };
  const listener = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        if (pending.has(socket)) return;
        pending.set(socket, payload);
        pump(socket);
      },
      drain: pump,
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
};

/** An echo server: every chunk back as it came. */
const echoServer = (): Upstream => {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        socket.write(chunk);
      },
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
};

interface Client {
  send(text: string): void;
  pause(): void;
  resume(): void;
  /** Resolves once at least `length` bytes have arrived in total. */
  received(length: number): Promise<number>;
  bytes(): number;
}

const dial = async (port: number): Promise<Client> => {
  let total = 0;
  let wake: () => void = () => undefined;
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_socket, chunk) {
        total += chunk.length;
        wake();
      },
    },
  });
  return {
    send: (value) => void socket.write(value),
    pause: () => void socket.pause(),
    resume: () => void socket.resume(),
    async received(length) {
      while (total < length) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return total;
    },
    bytes: () => total,
  };
};

const opened: { upstream?: Upstream; proxy?: FaultProxy } = {};

afterEach(() => {
  opened.proxy?.close();
  opened.upstream?.stop();
  delete opened.proxy;
  delete opened.upstream;
});

describe('faultProxy at its edges', () => {
  test('bytes a stalled client could not take are held and flushed on drain, none lost', async () => {
    const upstream = floodServer(PAYLOAD_BYTES);
    opened.upstream = upstream;
    const proxy = await faultProxy({ target: { hostname: '127.0.0.1', port: upstream.port } });
    opened.proxy = proxy;
    const client = await dial(proxy.port);
    // The client stops reading, so the proxy's writes to it come back short and queue.
    client.pause();
    client.send('go');
    while (proxy.counts().bytesDown < PAYLOAD_BYTES) await Bun.sleep(10);
    expect(client.bytes()).toBe(0);
    client.resume();
    expect(await client.received(PAYLOAD_BYTES)).toBe(PAYLOAD_BYTES);
    expect(proxy.counts()).toMatchObject({ bytesDown: PAYLOAD_BYTES, held: 0 });
  }, 20_000);

  test('a delay with no injected sleep still delivers, on the wall clock', async () => {
    const upstream = echoServer();
    opened.upstream = upstream;
    const proxy = await faultProxy({
      target: { hostname: '127.0.0.1', port: upstream.port },
      mode: { kind: 'delay', ms: 1 },
    });
    opened.proxy = proxy;
    const client = await dial(proxy.port);
    client.send('abc');
    expect(await client.received(3)).toBe(3);
  });

  test('a proxy born refusing keeps its port and listens on it once set to pass', async () => {
    const upstream = echoServer();
    opened.upstream = upstream;
    const proxy = await faultProxy({
      target: { hostname: '127.0.0.1', port: upstream.port },
      mode: { kind: 'refuse' },
    });
    opened.proxy = proxy;
    const first = await dial(proxy.port).then(
      () => 'connected',
      () => 'refused',
    );
    expect(first).toBe('refused');
    await proxy.set({ kind: 'pass' });
    const client = await dial(proxy.port);
    client.send('ok');
    expect(await client.received(2)).toBe(2);
  });

  test('mode answers the fault in force, as set and as screened', async () => {
    const upstream = echoServer();
    opened.upstream = upstream;
    const proxy = await faultProxy({ target: { hostname: '127.0.0.1', port: upstream.port } });
    opened.proxy = proxy;
    expect(proxy.mode).toEqual({ kind: 'pass' });
    await proxy.set({ kind: 'delay', ms: 5 });
    expect(proxy.mode).toEqual({ kind: 'delay', ms: 5 });
    await proxy.set({ kind: 'blackhole' });
    expect(proxy.mode.kind).toBe('blackhole');
  });
});
