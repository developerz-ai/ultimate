// The fault proxy, each mode against a real loopback echo server: pass, delay, blackhole, reset and
// refuse, and a switch mid-stream that holds the bytes in flight rather than dropping them.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import type { FaultProxy } from './fault-proxy';
import { faultProxy, faultTarget, screenFaultMode, throughFaultProxy } from './fault-proxy';

interface Echo {
  readonly port: number;
  stop(): void;
}

/** A server that answers every byte with itself, upper-cased: an answer is visibly the server's. */
const echoServer = (): Echo => {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        socket.write(new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase()));
      },
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
};

interface Client {
  send(text: string): void;
  /** Resolves once `length` characters have arrived in total. */
  received(length: number): Promise<string>;
  text(): string;
  readonly closed: Promise<void>;
}

const dial = async (port: number): Promise<Client> => {
  let text = '';
  let wake: () => void = () => undefined;
  let onClose: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  const socket: Socket<undefined> = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_socket, chunk) {
        text += new TextDecoder().decode(chunk);
        wake();
      },
      close: () => onClose(),
      error: () => onClose(),
    },
  });
  return {
    send: (value) => void socket.write(value),
    async received(length) {
      while (text.length < length) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return text;
    },
    text: () => text,
    closed,
  };
};

/** A few event-loop turns: long enough for loopback bytes to have crossed, if they were going to. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

const open: { echo?: Echo; proxy?: FaultProxy } = {};

afterEach(() => {
  open.proxy?.close();
  open.echo?.stop();
});

const start = async (options: Partial<Parameters<typeof faultProxy>[0]> = {}) => {
  const echo = echoServer();
  const proxy = await faultProxy({
    target: { hostname: '127.0.0.1', port: echo.port },
    ...options,
  });
  open.echo = echo;
  open.proxy = proxy;
  return { echo, proxy };
};

describe('faultProxy', () => {
  test('pass forwards both ways and counts the bytes', async () => {
    const { proxy } = await start();
    const client = await dial(proxy.port);
    client.send('hello');
    expect(await client.received(5)).toBe('HELLO');
    expect(proxy.counts()).toMatchObject({ accepted: 1, bytesUp: 5, bytesDown: 5, open: 1 });
  });

  test('delay holds every chunk until its wait ends, in order', async () => {
    const gates: (() => void)[] = [];
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        gates.push(resolve);
      });
    const { proxy } = await start({ mode: { kind: 'delay', ms: 50 }, sleep });
    const client = await dial(proxy.port);
    client.send('ab');
    await settle();
    expect(client.text()).toBe('');
    // The up leg's wait, then the down leg's.
    gates.shift()?.();
    await settle();
    expect(client.text()).toBe('');
    gates.shift()?.();
    expect(await client.received(2)).toBe('AB');
  });

  test('blackhole accepts and answers nothing, and the held bytes cross on pass', async () => {
    const { proxy } = await start();
    const client = await dial(proxy.port);
    client.send('one');
    expect(await client.received(3)).toBe('ONE');
    await proxy.set({ kind: 'blackhole' });
    client.send('two');
    await settle();
    expect(client.text()).toBe('ONE');
    expect(proxy.counts().held).toBe(3);
    // A new connection is accepted too — a black hole completes the handshake.
    const second = await dial(proxy.port);
    second.send('x');
    await settle();
    expect(second.text()).toBe('');
    await proxy.set({ kind: 'pass' });
    expect(await client.received(6)).toBe('ONETWO');
    expect(await second.received(1)).toBe('X');
    expect(proxy.counts().held).toBe(0);
  });

  test('an answer already on its way back is held by a switch to blackhole, not dropped', async () => {
    const gates: (() => void)[] = [];
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        gates.push(resolve);
      });
    const { proxy } = await start({ mode: { kind: 'delay', ms: 10 }, sleep });
    const client = await dial(proxy.port);
    client.send('q');
    await settle();
    gates.shift()?.();
    await settle();
    // The answer is in the down leg's wait now; the path goes dark before it lands.
    await proxy.set({ kind: 'blackhole' });
    gates.shift()?.();
    await settle();
    expect(client.text()).toBe('');
    expect(proxy.counts().held).toBe(1);
    await proxy.set({ kind: 'pass' });
    expect(await client.received(1)).toBe('Q');
  });

  test('reset cuts every live connection and every new one', async () => {
    const { proxy } = await start();
    const client = await dial(proxy.port);
    client.send('a');
    await client.received(1);
    await proxy.set({ kind: 'reset' });
    await client.closed;
    const next = await dial(proxy.port);
    await next.closed;
    expect(proxy.counts()).toMatchObject({ reset: 2, open: 0 });
  });

  test('refuse stops listening, and pass listens again on the same port', async () => {
    const { proxy } = await start();
    const port = proxy.port;
    await proxy.set({ kind: 'refuse' });
    const refused = await dial(port).then(
      () => 'connected',
      () => 'refused',
    );
    expect(refused).toBe('refused');
    await proxy.set({ kind: 'pass' });
    expect(proxy.port).toBe(port);
    const client = await dial(port);
    client.send('back');
    expect(await client.received(4)).toBe('BACK');
  });

  test('a dial the real service refuses is counted and cut', async () => {
    const { echo, proxy } = await start();
    echo.stop();
    const client = await dial(proxy.port);
    await client.closed;
    expect(proxy.counts().upstreamFailed).toBe(1);
  });

  test('set after close is refused', async () => {
    const { proxy } = await start();
    proxy.close();
    await expect(proxy.set({ kind: 'pass' })).rejects.toMatchObject({ code: 'X_INVARIANT' });
  });
});

describe('screenFaultMode', () => {
  test('refuses a delay that is not a whole number of milliseconds', () => {
    expect(() => screenFaultMode({ kind: 'delay', ms: Number.NaN })).toThrow(/delay ms/);
    expect(() => screenFaultMode({ kind: 'delay', ms: 2 ** 40 })).toThrow(/longest a timer/);
  });
});

describe('throughFaultProxy', () => {
  test('keeps scheme, credentials, database and query, and moves only the address', () => {
    expect(throughFaultProxy('postgres://u:p@db.internal:5432/app?sslmode=disable', 41_000)).toBe(
      'postgres://u:p@127.0.0.1:41000/app?sslmode=disable',
    );
    expect(throughFaultProxy('redis://127.0.0.1:6379', 41_001)).toBe('redis://127.0.0.1:41001');
    expect(throughFaultProxy('nats://127.0.0.1:4222', 41_002)).toBe('nats://127.0.0.1:41002');
  });

  test('faultTarget reads the port, or the scheme default', () => {
    expect(faultTarget('postgres://u:p@db:6000/x')).toEqual({ hostname: 'db', port: 6000 });
    expect(faultTarget('redis://cache')).toEqual({ hostname: 'cache', port: 6379 });
    expect(() => faultTarget('http2://x')).toThrow(/names no port/);
  });
});
