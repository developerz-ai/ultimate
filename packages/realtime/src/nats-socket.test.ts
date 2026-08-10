// Tests for `parseNatsUrl` and `natsStreamOver` against a fake `BunConnect` driven by hand — no
// real network, no timers. Mirrors the technique in `pg-socket.test.ts`: `FakeSocket.onWrite`
// fires synchronously inside `write`, so a scripted reply lands in the read queue before the
// caller ever awaits it — copied by hand here since that file's fakes are not exported.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import { type NatsTarget, natsStreamOver, parseNatsUrl } from './nats-socket';
import type { BunConnect, SocketHandlers, SocketLike } from './pg-socket';

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const causeOf = (value: unknown): string =>
  isUltimateError(value) ? value.cause : `not an UltimateError: ${String(value)}`;

describe('parseNatsUrl', () => {
  test('parses a full URL: user, password, port, tls', () => {
    const target = parseNatsUrl('nats://alice:s3cret@bus.example.test:4333');
    expect(target).toEqual({
      host: 'bus.example.test',
      port: 4333,
      tls: false,
      user: 'alice',
      pass: 's3cret',
      token: undefined,
    });
  });

  test('defaults: no port -> 4222, no credentials -> undefined', () => {
    const target = parseNatsUrl('nats://bus.example.test');
    expect(target).toEqual({
      host: 'bus.example.test',
      port: 4222,
      tls: false,
      user: undefined,
      pass: undefined,
      token: undefined,
    });
  });

  test('a username with no password is the token form', () => {
    const target = parseNatsUrl('nats://sometoken@bus.example.test');
    expect(target.token).toBe('sometoken');
    expect(target.user).toBeUndefined();
    expect(target.pass).toBeUndefined();
  });

  test('percent-encoded user and password are decoded', () => {
    const target = parseNatsUrl('nats://ali%40ce:p%40ss@bus.example.test');
    expect(target.user).toBe('ali@ce');
    expect(target.pass).toBe('p@ss');
  });

  test('tls: scheme sets tls: true', () => {
    expect(parseNatsUrl('tls://bus.example.test').tls).toBe(true);
    expect(parseNatsUrl('nats://bus.example.test').tls).toBe(false);
  });

  test('a non-nats scheme or a non-URL string is X_TRANSPORT_UNAVAILABLE', () => {
    for (const bad of ['http://user:pass@host/db', 'not a url at all']) {
      const error = thrown(() => parseNatsUrl(bad));
      expect(error).toBeInstanceOf(TransportUnavailableError);
      expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    }
  });

  test('an empty host is X_TRANSPORT_UNAVAILABLE', () => {
    const error = thrown(() => parseNatsUrl('nats://'));
    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
  });
});

type UpgradeOptions = {
  readonly tls: { readonly serverName: string; readonly rejectUnauthorized?: boolean };
  readonly socket: SocketHandlers;
};

/**
 * A `SocketLike` driven by hand: `onWrite` fires synchronously inside `write`, before `write`
 * returns, so a test can script a server reaction that is already sitting in the queue by the
 * time the caller awaits it — no microtask-counting, no race. `onUpgrade` defaults to throwing so
 * a test that never expects an upgrade fails loudly if the source calls one anyway.
 */
class FakeSocket implements SocketLike {
  readonly writes: number[] = [];
  writeReturns: (length: number) => number = (length) => length;
  onWrite: (data: Uint8Array) => void = () => {};
  ended = false;
  upgradeCalls = 0;
  onUpgrade: (options: UpgradeOptions) => readonly SocketLike[] = () => {
    throw new Error('this fake socket does not expect upgradeTLS to be called');
  };

  write(data: Uint8Array): number {
    this.writes.push(data.length);
    this.onWrite(data);
    return this.writeReturns(data.length);
  }

  end(): void {
    this.ended = true;
  }

  upgradeTLS(options: UpgradeOptions): readonly SocketLike[] {
    this.upgradeCalls += 1;
    return this.onUpgrade(options);
  }
}

class FakeRuntime implements BunConnect {
  readonly socket = new FakeSocket();
  #handlers: SocketHandlers | undefined;

  connect(options: {
    readonly hostname: string;
    readonly port: number;
    readonly socket: SocketHandlers;
  }): Promise<SocketLike> {
    this.#handlers = options.socket;
    return Promise.resolve(this.socket);
  }

  /** The handlers Bun itself would call — registered once, by `connect`. */
  events(): SocketHandlers {
    if (this.#handlers === undefined) throw new Error('connect() has not run yet');
    return this.#handlers;
  }
}

const TARGET_HOST = 'bus.example.test';

const natsTarget = (overrides: Partial<NatsTarget> = {}): NatsTarget => ({
  host: TARGET_HOST,
  port: 4222,
  tls: false,
  user: undefined,
  pass: undefined,
  token: undefined,
  ...overrides,
});

describe('natsStreamOver', () => {
  test('connecting performs no handshake: nothing is written or read up front', async () => {
    const runtime = new FakeRuntime();
    await natsStreamOver(runtime, natsTarget());

    expect(runtime.socket.writes).toEqual([]);
  });

  test('read() hands back a chunk the server pushed', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());

    runtime.events().data(runtime.socket, new Uint8Array([1, 2, 3]));

    expect(Array.from((await stream.read()) ?? [])).toEqual([1, 2, 3]);
  });

  test('a read() parked before the chunk arrives is released once it does', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());

    const pending = stream.read();
    runtime.events().data(runtime.socket, new Uint8Array([9]));

    expect(Array.from((await pending) ?? [])).toEqual([9]);
  });

  test('a closed socket yields undefined from read() (EOF)', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());

    runtime.events().close();

    expect(await stream.read()).toBeUndefined();
  });

  test('a read() parked before close()/end() is released with undefined (EOF)', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());

    const pending = stream.read();
    runtime.events().end();

    expect(await pending).toBeUndefined();
  });

  test('a socket error rejects a parked read with X_TRANSPORT_UNAVAILABLE naming host:port', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());

    const pending = caught(stream.read());
    runtime.events().error(runtime.socket, new Error('ECONNRESET'));
    const error = await pending;

    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(error)).toContain(`${TARGET_HOST}:4222`);
  });

  test('close()/end() releases a write parked on drain, which then fails on the next write (a dead socket never drains)', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());
    let dead = false;
    runtime.socket.writeReturns = (length) => (dead ? -1 : Math.min(4, length));

    const pending = caught(stream.write(new Uint8Array(10)));
    dead = true;
    runtime.events().close();
    const error = await pending;

    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(runtime.socket.writes).toEqual([10, 6]);
  });

  test('a partially accepted write parks until drain(), then writes the remainder', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());
    let accepted = 4;
    runtime.socket.writeReturns = (length) => Math.min(accepted, length);

    const pending = stream.write(new Uint8Array(10));
    accepted = 10;
    runtime.events().drain();
    await pending;

    expect(runtime.socket.writes).toEqual([10, 6]);
  });

  test('a write the socket refuses (-1) throws rather than parking for drain', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());
    runtime.socket.writeReturns = () => -1;

    const error = await caught(stream.write(new Uint8Array([1, 2, 3])));

    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
  });

  test('upgradeTls() switches later I/O to the TLS socket; a second call throws', async () => {
    const runtime = new FakeRuntime();
    const tlsSocket = new FakeSocket();
    let serverName: string | undefined;
    runtime.socket.onUpgrade = (options) => {
      serverName = options.tls.serverName;
      return [runtime.socket, tlsSocket];
    };
    const stream = await natsStreamOver(runtime, natsTarget({ tls: true }));

    stream.upgradeTls();
    await stream.write(new Uint8Array([7, 7, 7]));

    expect(runtime.socket.upgradeCalls).toBe(1);
    expect(serverName).toBe(TARGET_HOST);
    // Nothing ever reached the raw socket; the write landed on the different object `upgradeTLS`
    // returned, proving the reassignment, not just the call count.
    expect(runtime.socket.writes).toEqual([]);
    expect(tlsSocket.writes).toEqual([3]);

    const error = thrown(() => stream.upgradeTls());
    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(runtime.socket.upgradeCalls).toBe(1);
  });

  test('an upgrade that returns no TLS socket is X_TRANSPORT_UNAVAILABLE naming `bun upgrade`', async () => {
    const runtime = new FakeRuntime();
    runtime.socket.onUpgrade = () => [runtime.socket, undefined as unknown as SocketLike];
    const stream = await natsStreamOver(runtime, natsTarget({ tls: true }));

    const error = thrown(() => stream.upgradeTls());

    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(isUltimateError(error) ? error.fix : '').toContain('bun upgrade');
  });

  test('close() ends the socket', async () => {
    const runtime = new FakeRuntime();
    const stream = await natsStreamOver(runtime, natsTarget());

    stream.close();

    expect(runtime.socket.ended).toBe(true);
  });
});
