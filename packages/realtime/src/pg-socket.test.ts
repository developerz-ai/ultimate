// Tests for `parsePgUrl` and `pgStreamOver` against a fake `BunConnect` driven by hand — no real
// network, no timers. `FakeSocket.onWrite` fires synchronously inside `write`, so a scripted reply
// (or a close) lands in the read queue before `pgStreamOver` ever awaits it: the SSL handshake
// races nothing, the same technique `smtp-socket.test.ts` uses for its runtime-injected failures.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import {
  type BunConnect,
  type PgTarget,
  parsePgUrl,
  pgStreamOver,
  type SocketHandlers,
  type SocketLike,
} from './pg-socket';

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

describe('parsePgUrl', () => {
  test('parses a full URL: user, password, port, database, sslmode', () => {
    const target = parsePgUrl('postgres://alice:s3cret@db.example.test:6543/appdb?sslmode=require');
    expect(target).toEqual({
      host: 'db.example.test',
      port: 6543,
      database: 'appdb',
      user: 'alice',
      password: 's3cret',
      ssl: 'require',
    });
  });

  test('defaults: no port, no database, no user, no password, no sslmode', () => {
    const target = parsePgUrl('postgres://db.example.test');
    expect(target).toEqual({
      host: 'db.example.test',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password: undefined,
      ssl: 'prefer',
    });
  });

  test('percent-encoded password and database are decoded', () => {
    const target = parsePgUrl('postgres://alice:p%40ss@db.example.test/my%20db');
    expect(target.password).toBe('p@ss');
    expect(target.database).toBe('my db');
  });

  test('postgresql: is accepted as a scheme', () => {
    expect(parsePgUrl('postgresql://db.example.test/db').host).toBe('db.example.test');
  });

  test('a non-postgres scheme or a non-URL string is X_REPLICATION_FAILED', () => {
    for (const bad of ['mysql://user:pass@host/db', 'not a url at all']) {
      const error = thrown(() => parsePgUrl(bad));
      expect(error).toBeInstanceOf(ReplicationFailedError);
      expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
    }
  });

  /**
   * The rejected value is a connection URL, so it carries the database password — and an error is
   * the one value that is rendered everywhere: a log line, `--json`, an agent's transcript, a
   * ticket. Name the variable that has to change, the way `driver-smtp.ts:68` does.
   */
  test('a malformed URL is refused without echoing the credential in it', () => {
    const error = thrown(() => parsePgUrl('postgres://alice:hunter2@:not-a-port/db'));
    expect(error).toBeInstanceOf(ReplicationFailedError);
    const rendered = JSON.stringify(error);
    expect(rendered).not.toContain('hunter2');
    expect(rendered).toContain('DATABASE_URL');
  });

  test('an unknown sslmode is refused', () => {
    const error = thrown(() => parsePgUrl('postgres://db.example.test/db?sslmode=verify-full'));
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
  });
});

type UpgradeOptions = {
  readonly tls: { readonly serverName: string; readonly rejectUnauthorized?: boolean };
  readonly socket: SocketHandlers;
};

/**
 * A `SocketLike` driven by hand: `onWrite` fires synchronously inside `write`, before `write`
 * returns, so a test can script a server reply that is already sitting in the queue by the time
 * `pgStreamOver` awaits it — no microtask-counting, no race. `onUpgrade` defaults to throwing so
 * a test that never expects an upgrade fails loudly if the source calls one anyway.
 */
class FakeSocket implements SocketLike {
  readonly writes: number[] = [];
  writeReturns: (length: number) => number = (length) => length;
  onWrite: (data: Uint8Array) => void = () => {};
  ended = false;
  upgradeCalls = 0;
  onUpgrade: (options: UpgradeOptions) => readonly SocketLike[] = () =>
    expect.unreachable('this fake socket does not expect upgradeTLS to be called');

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
    if (this.#handlers === undefined) expect.unreachable('connect() has not run yet');
    return this.#handlers;
  }
}

const TARGET_HOST = 'db.example.test';

const pgTarget = (overrides: Partial<PgTarget> = {}): PgTarget => ({
  host: TARGET_HOST,
  port: 5432,
  database: 'appdb',
  user: 'repluser',
  password: 'secret',
  ssl: 'prefer',
  ...overrides,
});

/** Scripts the answer to the SSLRequest: fires once, on the very next write, then goes quiet. */
const onSslRequest = (runtime: FakeRuntime, reply: () => void): void => {
  runtime.socket.onWrite = () => {
    runtime.socket.onWrite = () => {};
    reply();
  };
};

describe('pgStreamOver', () => {
  test("ssl: disable sends no SSLRequest; the first bytes written are the caller's own", async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    await stream.write(new Uint8Array([1, 2, 3]));

    expect(runtime.socket.writes).toEqual([3]);
  });

  test('ssl: prefer sends the 8-byte SSLRequest first; an N answer continues in cleartext', async () => {
    const runtime = new FakeRuntime();
    onSslRequest(runtime, () => runtime.events().data(runtime.socket, new Uint8Array([0x4e])));

    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'prefer' }));
    await stream.write(new Uint8Array([7, 7]));

    expect(runtime.socket.upgradeCalls).toBe(0);
    expect(runtime.socket.writes).toEqual([8, 2]);
  });

  test('ssl: require + an N answer throws X_REPLICATION_FAILED', async () => {
    const runtime = new FakeRuntime();
    onSslRequest(runtime, () => runtime.events().data(runtime.socket, new Uint8Array([0x4e])));

    const error = await caught(pgStreamOver(runtime, pgTarget({ ssl: 'require' })));

    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
  });

  test('an S answer upgrades: upgradeTLS runs once with serverName = host; later I/O uses its socket', async () => {
    const runtime = new FakeRuntime();
    const tlsSocket = new FakeSocket();
    let serverName: string | undefined;
    runtime.socket.onUpgrade = (options) => {
      serverName = options.tls.serverName;
      return [runtime.socket, tlsSocket];
    };
    onSslRequest(runtime, () => runtime.events().data(runtime.socket, new Uint8Array([0x53])));

    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'prefer' }));
    await stream.write(new Uint8Array([9, 9, 9]));
    stream.close();

    expect(runtime.socket.upgradeCalls).toBe(1);
    expect(serverName).toBe(TARGET_HOST);
    // Only the SSLRequest ever reached the raw socket; the post-upgrade write landed on the
    // different object `upgradeTLS` returned, proving the reassignment, not just the call count.
    expect(runtime.socket.writes).toEqual([8]);
    expect(tlsSocket.writes).toEqual([3]);
    expect(tlsSocket.ended).toBe(true);
    expect(runtime.socket.ended).toBe(false);
  });

  test('an S answer followed by extra bytes in the same chunk is X_REPLICATION_PROTOCOL', async () => {
    const runtime = new FakeRuntime();
    onSslRequest(runtime, () =>
      runtime.events().data(runtime.socket, new Uint8Array([0x53, 1, 2, 3])),
    );

    const error = await caught(pgStreamOver(runtime, pgTarget({ ssl: 'prefer' })));

    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect(codeOf(error)).toBe('X_REPLICATION_PROTOCOL');
  });

  test('the server closing before answering the SSLRequest is a failed handshake, not an EOF', async () => {
    const runtime = new FakeRuntime();
    onSslRequest(runtime, () => runtime.events().close());

    const error = await caught(pgStreamOver(runtime, pgTarget({ ssl: 'prefer' })));

    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
  });

  test('read() hands back chunks in arrival order and undefined once the socket closes', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    runtime.events().data(runtime.socket, new Uint8Array([1, 2]));
    runtime.events().data(runtime.socket, new Uint8Array([3, 4, 5]));

    expect(Array.from((await stream.read()) ?? [])).toEqual([1, 2]);
    expect(Array.from((await stream.read()) ?? [])).toEqual([3, 4, 5]);

    runtime.events().close();

    expect(await stream.read()).toBeUndefined();
  });

  test('a partially accepted write parks until drain(), then writes the remainder', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));
    let accepted = 4;
    runtime.socket.writeReturns = (length) => Math.min(accepted, length);

    const pending = stream.write(new Uint8Array(10));
    accepted = 10;
    runtime.events().drain();
    await pending;

    expect(runtime.socket.writes).toEqual([10, 6]);
  });

  test('a second read() while one is parked is refused, and the parked one still gets its chunk', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    const parked = stream.read();
    const error = await caught(stream.read());

    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect(codeOf(error)).toBe('X_REPLICATION_PROTOCOL');

    // The first reader was never overwritten: it is still the one the next chunk goes to.
    runtime.events().data(runtime.socket, new Uint8Array([4, 2]));
    expect(Array.from((await parked) ?? [])).toEqual([4, 2]);
  });

  test('a read() after a parked one has been served is fine — the refusal is concurrency only', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    const first = stream.read();
    runtime.events().data(runtime.socket, new Uint8Array([1]));
    expect(Array.from((await first) ?? [])).toEqual([1]);

    const second = stream.read();
    runtime.events().data(runtime.socket, new Uint8Array([2]));
    expect(Array.from((await second) ?? [])).toEqual([2]);
  });

  test('a queued chunk is a copy: mutating the buffer after the callback cannot corrupt it', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    const bunBuffer = new Uint8Array([1, 2, 3]);
    runtime.events().data(runtime.socket, bunBuffer);
    // Bun makes no promise that the chunk survives the callback — this is that reuse, staged.
    bunBuffer.set([9, 9, 9]);

    expect(Array.from((await stream.read()) ?? [])).toEqual([1, 2, 3]);
  });

  test('a chunk handed to a parked read() is a copy too, not the buffer Bun passed in', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    const parked = stream.read();
    const bunBuffer = new Uint8Array([7, 7]);
    runtime.events().data(runtime.socket, bunBuffer);
    bunBuffer.set([0, 0]);

    expect(Array.from((await parked) ?? [])).toEqual([7, 7]);
  });

  test('a write the socket refuses (-1) fails at once rather than waiting for a drain', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));
    runtime.socket.writeReturns = () => -1;

    const error = await caught(stream.write(new Uint8Array([1, 2, 3])));

    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
  });
});

describe('a socket error ends the stream for everyone on it', () => {
  test('a reader that arrives after the error is rejected, not left hanging on a dead socket', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    runtime.events().error(runtime.socket, new Error('ECONNRESET'));

    const error = await caught(stream.read());
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
    // The refusal has to name the peer an operator would open a route to, not just "socket error".
    expect(isUltimateError(error) ? error.cause : '').toContain('ECONNRESET');
    expect(isUltimateError(error) ? error.fix : '').toContain(`${TARGET_HOST}:5432`);
  });

  test('a reader already parked when the error lands is rejected rather than resolved with EOF', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    const parked = stream.read();
    runtime.events().error(runtime.socket, new Error('broken pipe'));

    const error = await caught(parked);
    expect(codeOf(error)).toBe('X_REPLICATION_FAILED');
    expect(isUltimateError(error) ? error.cause : '').toContain('broken pipe');
  });

  test('chunks that arrived before the error are still handed over first', async () => {
    const runtime = new FakeRuntime();
    const stream = await pgStreamOver(runtime, pgTarget({ ssl: 'disable' }));

    runtime.events().data(runtime.socket, new Uint8Array([1, 2]));
    runtime.events().error(runtime.socket, new Error('ECONNRESET'));

    // A buffered frame is still a frame the decoder can finish; the failure comes after it.
    expect(Array.from((await stream.read()) ?? [])).toEqual([1, 2]);
    expect(codeOf(await caught(stream.read()))).toBe('X_REPLICATION_FAILED');
  });
});
