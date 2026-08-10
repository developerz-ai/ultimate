// Tests for the NATS session: the handshake, the read loop, and request/reply. Error paths run
// against a scripted stream driven by hand; the happy paths run against the in-memory server, so
// the same bytes travel both ways rather than being asserted twice in two shapes.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { NatsConnection } from './nats-connection';
import { FakeNatsServer } from './nats-fake';
import type { NatsStream, NatsTarget } from './nats-socket';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TARGET: NatsTarget = {
  host: 'bus.test',
  port: 4222,
  tls: false,
  user: undefined,
  pass: undefined,
  token: undefined,
};

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** A stream whose server side is a script: the test pushes bytes and reads what the client wrote. */
class ScriptedStream implements NatsStream {
  readonly writes: string[] = [];
  upgrades = 0;
  closed = false;
  readonly #queue: (Uint8Array | undefined)[] = [];
  #waiting: ((chunk: Uint8Array | undefined) => void) | undefined;

  constructor(...script: string[]) {
    for (const text of script) this.push(text);
  }

  push(text: string): void {
    const chunk = encoder.encode(text);
    const waiter = this.#waiting;
    this.#waiting = undefined;
    if (waiter) waiter(chunk);
    else this.#queue.push(chunk);
  }

  eof(): void {
    const waiter = this.#waiting;
    this.#waiting = undefined;
    if (waiter) waiter(undefined);
    else this.#queue.push(undefined);
  }

  read(): Promise<Uint8Array | undefined> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift());
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.writes.push(decoder.decode(bytes));
  }

  upgradeTls(): void {
    this.upgrades += 1;
  }

  close(): void {
    this.closed = true;
    this.eof();
  }
}

const INFO = 'INFO {"server_id":"S","version":"2.11.0","max_payload":1048576,"headers":true}\r\n';

const openScripted = async (
  stream: ScriptedStream,
  target: NatsTarget = TARGET,
): Promise<NatsConnection> =>
  await NatsConnection.open({ stream, target, rng: () => 0.5, requestTimeoutMs: 50 });

const openFake = async (server: FakeNatsServer): Promise<NatsConnection> =>
  await NatsConnection.open({
    stream: server.connect(),
    target: TARGET,
    rng: () => 0.5,
    requestTimeoutMs: 200,
  });

describe('NatsConnection.open', () => {
  test('sends CONNECT and PING, and returns once the server answers PONG', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const connection = await openScripted(stream);

    expect(stream.writes[0]).toStartWith('CONNECT {');
    expect(stream.writes[1]).toBe('PING\r\n');
    expect(connection.info.version).toBe('2.11.0');
    await connection.close();
  });

  test('credentials from the target ride in CONNECT', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const connection = await openScripted(stream, { ...TARGET, user: 'alice', pass: 's3cret' });

    const sent: unknown = JSON.parse((stream.writes[0] ?? '').slice('CONNECT '.length));
    expect(sent).toMatchObject({ user: 'alice', pass: 's3cret', headers: true, protocol: 1 });
    await connection.close();
  });

  test('a tls: target upgrades the stream before CONNECT', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const connection = await openScripted(stream, { ...TARGET, tls: true });

    expect(stream.upgrades).toBe(1);
    await connection.close();
  });

  test('tls_required in INFO upgrades even on a nats: url', async () => {
    const stream = new ScriptedStream(
      'INFO {"server_id":"S","version":"2.11.0","tls_required":true}\r\n',
      'PONG\r\n',
    );
    const connection = await openScripted(stream);

    expect(stream.upgrades).toBe(1);
    await connection.close();
  });

  test('bytes after INFO but before the TLS upgrade are X_TRANSPORT_PROTOCOL', async () => {
    const stream = new ScriptedStream(`${INFO}PONG\r\n`);

    expect(codeOf(await caught(openScripted(stream, { ...TARGET, tls: true })))).toBe(
      'X_TRANSPORT_PROTOCOL',
    );
  });

  test('an operation other than INFO first is X_TRANSPORT_PROTOCOL', async () => {
    expect(codeOf(await caught(openScripted(new ScriptedStream('PING\r\n'))))).toBe(
      'X_TRANSPORT_PROTOCOL',
    );
  });

  test('EOF before INFO is X_TRANSPORT_UNAVAILABLE', async () => {
    const stream = new ScriptedStream();
    stream.eof();

    expect(codeOf(await caught(openScripted(stream)))).toBe('X_TRANSPORT_UNAVAILABLE');
  });

  test('-ERR instead of PONG names the credentials problem', async () => {
    const stream = new ScriptedStream(INFO, "-ERR 'Authorization Violation'\r\n");
    const error = await caught(openScripted(stream));

    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(isUltimateError(error) ? error.cause : '').toContain('Authorization Violation');
  });
});

describe('the read loop', () => {
  test('a server PING is answered with PONG', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const connection = await openScripted(stream);

    stream.push('PING\r\n');
    await Bun.sleep(1);

    expect(stream.writes).toContain('PONG\r\n');
    await connection.close();
  });

  test('flush resolves on the matching PONG', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const connection = await openScripted(stream);

    const flushed = connection.flush();
    stream.push('PONG\r\n');
    await flushed;

    expect(stream.writes.filter((write) => write === 'PING\r\n')).toHaveLength(2);
    await connection.close();
  });

  test('a permissions violation is reported but does not close the connection', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const seen: unknown[] = [];
    const connection = await NatsConnection.open({
      stream,
      target: TARGET,
      onError: (error) => seen.push(error),
    });

    stream.push('-ERR \'Permissions Violation for Subscription to "secret"\'\r\n');
    await Bun.sleep(1);

    expect(seen).toHaveLength(1);
    expect(connection.closed).toBe(false);
    await connection.close();
  });

  test('any other -ERR closes the connection and reports it', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const closes: unknown[] = [];
    const connection = await NatsConnection.open({
      stream,
      target: TARGET,
      onClose: (error) => closes.push(error),
    });

    stream.push("-ERR 'Stale Connection'\r\n");
    await Bun.sleep(1);

    expect(connection.closed).toBe(true);
    expect(codeOf(closes[0])).toBe('X_TRANSPORT_UNAVAILABLE');
  });

  test('EOF closes the connection and settles a parked request', async () => {
    const stream = new ScriptedStream(INFO, 'PONG\r\n');
    const connection = await openScripted(stream);

    const pending = caught(connection.request('somewhere', new Uint8Array(0)));
    await Bun.sleep(1);
    stream.eof();

    expect(codeOf(await pending)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(connection.closed).toBe(true);
  });
});

describe('publish and subscribe', () => {
  test('a subject with whitespace is refused before it reaches the wire', async () => {
    const connection = await openFake(new FakeNatsServer());

    expect(
      codeOf(await caught(connection.publish('x change\r\nPUB evil', new Uint8Array(0)))),
    ).toBe('X_TRANSPORT_PROTOCOL');
    await connection.close();
  });

  test('a payload over the server max_payload is refused with the limit named', async () => {
    const connection = await openFake(new FakeNatsServer({ maxPayload: 8 }));

    const error = await caught(connection.publish('x.change', new Uint8Array(9)));

    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
    expect(isUltimateError(error) ? error.cause : '').toContain('max_payload of 8');
    await connection.close();
  });

  test('two connections on one server fan a publish out to a wildcard subscriber', async () => {
    const server = new FakeNatsServer();
    const publisher = await openFake(server);
    const subscriber = await openFake(server);
    const seen: string[] = [];

    await subscriber.subscribe('x.change.posts.*', (message) => {
      seen.push(`${message.subject}=${decoder.decode(message.payload)}`);
    });
    await publisher.publish('x.change.posts.org-1', encoder.encode('hello'));
    await Bun.sleep(1);

    expect(seen).toEqual(['x.change.posts.org-1=hello']);
    await publisher.close();
    await subscriber.close();
  });

  test('unsubscribe stops delivery and drops the handler', async () => {
    const server = new FakeNatsServer();
    const connection = await openFake(server);
    const seen: string[] = [];

    const subscription = await connection.subscribe('x.change.>', (message) => {
      seen.push(decoder.decode(message.payload));
    });
    await connection.publish('x.change.posts', encoder.encode('one'));
    await Bun.sleep(1);
    await subscription.unsubscribe();
    await connection.publish('x.change.posts', encoder.encode('two'));
    await Bun.sleep(1);

    expect(seen).toEqual(['one']);
    expect(connection.subscriptionCount).toBe(0);
    await connection.close();
  });

  test('publishing on a closed connection is X_TRANSPORT_UNAVAILABLE', async () => {
    const connection = await openFake(new FakeNatsServer());
    await connection.close();

    expect(codeOf(await caught(connection.publish('x.change', new Uint8Array(0))))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
  });
});

describe('request/reply', () => {
  test('a request is answered on its own inbox', async () => {
    const server = new FakeNatsServer();
    const connection = await openFake(server);

    const reply = await connection.request('$JS.API.STREAM.INFO.KV_missing', encoder.encode('{}'));

    expect(JSON.parse(decoder.decode(reply.payload))).toMatchObject({
      error: { code: 404 },
    });
    await connection.close();
  });

  test('two requests in flight do not cross their replies', async () => {
    const server = new FakeNatsServer();
    const connection = await openFake(server);
    await connection.request('$JS.API.STREAM.CREATE.KV_a', encoder.encode('{"name":"KV_a"}'));

    const [missing, found] = await Promise.all([
      connection.request('$JS.API.STREAM.INFO.KV_b', encoder.encode('{}')),
      connection.request('$JS.API.STREAM.INFO.KV_a', encoder.encode('{}')),
    ]);

    expect(decoder.decode(missing.payload)).toContain('stream not found');
    expect(decoder.decode(found.payload)).toContain('KV_a');
    await connection.close();
  });

  test('a request nobody answers times out with the subject named', async () => {
    const connection = await openFake(new FakeNatsServer());

    const error = await caught(
      connection.request('nobody.here', new Uint8Array(0), { timeoutMs: 20 }),
    );

    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(isUltimateError(error) ? error.cause : '').toContain('nobody.here');
    await connection.close();
  });

  test('requestMany collects every reply up to the terminator', async () => {
    const server = new FakeNatsServer();
    const connection = await openFake(server);
    await connection.request('$JS.API.STREAM.CREATE.KV_x', encoder.encode('{"name":"KV_x"}'));
    for (const key of ['a', 'b']) {
      await connection.request(`$KV.x.set.${key}`, encoder.encode(`value-${key}`));
    }

    const replies = await connection.requestMany(
      '$JS.API.DIRECT.GET.KV_x',
      encoder.encode(JSON.stringify({ multi_last: ['$KV.x.set.*'] })),
      { until: (message) => message.status !== undefined },
    );

    expect(replies).toHaveLength(3);
    expect(replies.slice(0, 2).map((reply) => decoder.decode(reply.payload))).toEqual([
      'value-a',
      'value-b',
    ]);
    expect(replies[2]?.status).toBe(204);
    await connection.close();
  });
});
