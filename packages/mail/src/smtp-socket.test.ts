// Tests for the production stream over a real loopback socket: chunks queue in order, a closed
// connection reads as EOF instead of hanging, and the STARTTLS upgrade is handed to the runtime in
// the shape it accepts. A completed TLS handshake needs a certificate authority and is not tested
// here — `driver-smtp.test.ts` covers the plaintext path end to end. The failures a real socket
// will not perform on cue (a refused write, a handshake that fails, a `drain` that never comes)
// run against `smtpStreamOver` with the runtime handed in.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { SmtpStream } from './smtp-client';
import {
  type BunConnect,
  bunSmtpStream,
  type SocketHandlers,
  type SocketLike,
  smtpStreamOver,
} from './smtp-socket';

interface Echo {
  readonly port: number;
  readonly received: string[];
  hangUp(): void;
  stop(): void;
}

/**
 * A server that greets, answers every line with `250 ok`, and can drop the connection on demand.
 * Answering is what makes the tests deterministic: reading the reply proves the server already
 * processed what was written to it, with no sleep to race against.
 */
function startEcho(): Echo {
  const received: string[] = [];
  const decoder = new TextDecoder();
  const sockets: { write(data: string): void; end(): void }[] = [];

  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        sockets.push(socket);
        socket.write('220 local.test ESMTP\r\n');
      },
      data(socket, chunk) {
        received.push(decoder.decode(chunk));
        socket.write('250 ok\r\n');
      },
    },
  });

  return {
    port: listener.port,
    received,
    hangUp: () => {
      for (const socket of sockets) socket.end();
    },
    stop: () => listener.stop(true),
  };
}

const target = (port: number): { host: string; port: number; tls: boolean; timeoutMs: number } => ({
  host: '127.0.0.1',
  port,
  tls: false,
  timeoutMs: 2_000,
});

test('chunks arrive in the order the server wrote them', async () => {
  const server = startEcho();
  try {
    const stream = await bunSmtpStream(target(server.port));

    expect(await stream.read()).toBe('220 local.test ESMTP\r\n');
    await stream.write('EHLO postly.test\r\n');

    expect(await stream.read()).toBe('250 ok\r\n');
    expect(server.received.join('')).toBe('EHLO postly.test\r\n');

    stream.close();
  } finally {
    server.stop();
  }
});

test('a server that hangs up reads as EOF rather than parking the reader forever', async () => {
  const server = startEcho();
  try {
    const stream = await bunSmtpStream(target(server.port));
    expect(await stream.read()).toContain('220');

    // The reader parks first, so this exercises the waiting path, not the buffered one.
    const pending = stream.read();
    server.hangUp();

    expect(await pending).toBeUndefined();
    expect(await stream.read()).toBeUndefined();
  } finally {
    server.stop();
  }
});

test('the STARTTLS upgrade is handed to the runtime in the shape it accepts', async () => {
  const server = startEcho();
  try {
    const stream = await bunSmtpStream(target(server.port));
    expect(await stream.read()).toContain('220');

    // `upgradeTLS` validates its options and throws on a wrong shape ("Expected \"socket\"
    // option"), so a clean resolve here is what proves the call site, not the handshake.
    await stream.startTls();

    stream.close();
  } finally {
    server.stop();
  }
});

test('a connection refused by nobody listening rejects instead of resolving a dead stream', async () => {
  const server = startEcho();
  const port = server.port;
  server.stop();

  const opened = await bunSmtpStream(target(port)).then(
    () => 'resolved',
    () => 'rejected',
  );

  expect(opened).toBe('rejected');
});

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const metaOf = (value: unknown): Readonly<Record<string, unknown>> =>
  isUltimateError(value) ? (value.meta ?? {}) : {};

const fixOf = (value: unknown): string => (isUltimateError(value) ? value.fix : '');

const causeOf = (value: unknown): string => (isUltimateError(value) ? value.cause : String(value));

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/**
 * The runtime, driven by hand: what `write` returns, when `drain` arrives, whether the TLS upgrade
 * yields a socket, and which event fires when. A real socket performs none of these on demand.
 * `timeoutMs` is deliberately long — a test that only passes because the deadline fired is not a
 * test of failing fast.
 */
class FakeRuntime implements BunConnect {
  /** Byte counts handed to `write`, in order. */
  readonly writes: number[] = [];
  /** What `write` returns for a given byte count. Full acceptance by default. */
  writeReturns: (length: number) => number = (length) => length;
  /** What `upgradeTLS` hands back. Bun's own shape is `[raw, tls]`. */
  tlsSockets: (raw: SocketLike) => readonly SocketLike[] = (raw) => [raw, raw];
  upgrades = 0;
  ended = false;

  readonly socket: SocketLike = {
    write: (data) => {
      this.writes.push(data.length);
      return this.writeReturns(data.length);
    },
    end: () => {
      this.ended = true;
    },
    upgradeTLS: (options) => {
      this.upgrades += 1;
      this.handlers = options.socket;
      return this.tlsSockets(this.socket);
    },
  };

  private handlers: SocketHandlers | undefined;

  connect(options: { readonly socket: SocketHandlers }): Promise<SocketLike> {
    this.handlers = options.socket;
    return Promise.resolve(this.socket);
  }

  /** The handlers the runtime would call. Registered by `connect`, re-registered by `upgradeTLS`. */
  events(): SocketHandlers {
    expect(this.handlers).toBeDefined();
    return this.handlers as SocketHandlers;
  }

  push(text: string): void {
    this.events().data(this.socket, new TextEncoder().encode(text));
  }
}

const FAKE_TARGET = { host: 'mail.example.test', port: 587, tls: false, timeoutMs: 30_000 };
/** `smtps://`: the socket is handed to TLS before a single SMTP byte is exchanged. */
const IMPLICIT_TLS_TARGET = { host: 'mail.example.test', port: 465, tls: true, timeoutMs: 30_000 };

const openFake = async (runtime: FakeRuntime, target = FAKE_TARGET): Promise<SmtpStream> =>
  await smtpStreamOver(runtime, target);

test('a write the socket refuses (-1) fails at once rather than waiting for a drain', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);
  runtime.writeReturns = () => -1;

  const started = Bun.nanoseconds();
  const error = await caught(stream.write('EHLO postly.test\r\n'));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('data');
  expect(metaOf(error)['retryable']).toBe(true);
  expect(causeOf(error)).toContain('refused');
  // A closed socket emits no `drain`, so the old path burned the whole 30s deadline first.
  expect(Bun.nanoseconds() - started).toBeLessThan(1e9);
});

test('a partial write still waits for drain, and the drain releases it', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);
  let accepted = 4;
  runtime.writeReturns = (length) => Math.min(accepted, length);

  const pending = stream.write('EHLO postly.test\r\n');
  accepted = 64;
  runtime.events().drain();

  await pending;
  expect(runtime.writes).toEqual([18, 14]);
});

test('a socket error releases a write parked for drain instead of leaving it to the deadline', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);
  runtime.writeReturns = () => 4;

  const started = Bun.nanoseconds();
  const pending = caught(stream.write('EHLO postly.test\r\n'));
  runtime.events().error(runtime.socket, new Error('read ECONNRESET'));
  const error = await pending;

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('data');
  expect(metaOf(error)['retryable']).toBe(true);
  expect(Bun.nanoseconds() - started).toBeLessThan(1e9);
});

test('a socket close releases a write parked for drain — no drain can follow it', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);
  runtime.writeReturns = () => 4;

  const pending = caught(stream.write('EHLO postly.test\r\n'));
  runtime.events().close();

  expect(codeOf(await pending)).toBe('X_MAIL_SEND_FAILED');
  // The reader still sees a clean EOF: only the parked write failed.
  expect(await stream.read()).toBeUndefined();
});

test('an error during the TLS handoff is a starttls failure, not a transient data one', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);

  await stream.startTls();
  // Bun buffers writes made before the handshake completes, so the client sends EHLO straight
  // away and the handshake failure arrives after it. That does not make it a DATA failure.
  await stream.write('EHLO postly.test\r\n');
  runtime.events().error(runtime.socket, new Error('SSL_ERROR: self signed certificate'));

  const error = await caught(stream.read());
  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('starttls');
  expect(metaOf(error)['retryable']).toBe(false);
  expect(causeOf(error)).toContain('self signed certificate');
  // The remedy is the host's certificate, not the runtime — that is the other, separate case —
  // and reproducing an in-band upgrade needs the `-starttls smtp` form of the command.
  expect(fixOf(error)).toContain('openssl s_client -starttls smtp -connect mail.example.test:587');
  expect(fixOf(error)).not.toContain('bun upgrade');
});

test('a close or an end during the handoff is a refused handshake, not a clean EOF', async () => {
  for (const fire of [
    (events: SocketHandlers): void => events.close(),
    (events: SocketHandlers): void => events.end(),
  ]) {
    const runtime = new FakeRuntime();
    const stream = await openFake(runtime);

    await stream.startTls();
    fire(runtime.events());

    const error = await caught(stream.read());
    expect(metaOf(error)['stage']).toBe('starttls');
    expect(metaOf(error)['retryable']).toBe(false);
  }
});

test('an EHLO sent immediately after the upgrade reaches the upgraded socket and reads back', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);

  await stream.startTls();
  await stream.write('EHLO postly.test\r\n');
  runtime.push('250 mail.example.test\r\n');

  expect(runtime.upgrades).toBe(1);
  expect(runtime.writes).toEqual([18]);
  expect(await stream.read()).toBe('250 mail.example.test\r\n');

  stream.close();
  // `close()` ends the upgraded socket, not the raw one it replaced.
  expect(runtime.ended).toBe(true);
});

test('once the upgraded socket has produced bytes, a socket error is transient again', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);

  await stream.startTls();
  runtime.push('250 mail.example.test\r\n');
  expect(await stream.read()).toBe('250 mail.example.test\r\n');
  // Encrypted bytes only flow after the handshake, so this reset is a mid-session one: retrying
  // the job can work, and calling it a permanent TLS failure would strand a deliverable message.
  runtime.events().error(runtime.socket, new Error('read ECONNRESET'));

  const error = await caught(stream.read());
  expect(metaOf(error)['stage']).toBe('data');
  expect(metaOf(error)['retryable']).toBe(true);
});

test('a runtime that hands back no TLS socket is the runtime-upgrade case, not a certificate one', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime);
  runtime.tlsSockets = (raw) => [raw];

  const error = await caught(stream.startTls());

  expect(metaOf(error)['stage']).toBe('starttls');
  expect(metaOf(error)['retryable']).toBe(false);
  expect(fixOf(error)).toContain('bun upgrade');
});

test('an implicit-TLS handshake that fails is permanent, and its own stage', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime, IMPLICIT_TLS_TARGET);

  // `smtps://` puts the handshake before the greeting, with no STARTTLS command anywhere in it —
  // so an expired certificate here used to read as a transient DATA failure and requeue the job
  // forever against something no retry can clear.
  runtime.events().error(runtime.socket, new Error('SSL_ERROR: certificate has expired'));

  const error = await caught(stream.read());
  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('tls');
  expect(metaOf(error)['retryable']).toBe(false);
  expect(causeOf(error)).toContain('certificate has expired');
  // The command that reproduces it is the plain one: there is no in-band upgrade to ask for.
  expect(fixOf(error)).toContain('openssl s_client -connect mail.example.test:465');
  expect(fixOf(error)).not.toContain('-starttls');
});

test('an implicit-TLS connection closing before the greeting is a refused handshake', async () => {
  for (const fire of [
    (events: SocketHandlers): void => events.close(),
    (events: SocketHandlers): void => events.end(),
  ]) {
    const runtime = new FakeRuntime();
    const stream = await openFake(runtime, IMPLICIT_TLS_TARGET);

    fire(runtime.events());

    // A host that hangs up before saying 220 on 465 rejected the handshake; EOF hides that.
    expect(metaOf(await caught(stream.read()))['stage']).toBe('tls');
    expect(metaOf(await caught(stream.read()))['retryable']).toBe(false);
  }
});

test('once an implicit-TLS host has greeted, a socket failure is transient again', async () => {
  const runtime = new FakeRuntime();
  const stream = await openFake(runtime, IMPLICIT_TLS_TARGET);

  // The 220 could not have arrived over an unfinished handshake, so the window is closed.
  runtime.push('220 mail.example.test ESMTP\r\n');
  expect(await stream.read()).toBe('220 mail.example.test ESMTP\r\n');
  runtime.events().error(runtime.socket, new Error('read ECONNRESET'));

  const error = await caught(stream.read());
  expect(metaOf(error)['stage']).toBe('data');
  expect(metaOf(error)['retryable']).toBe(true);
});
