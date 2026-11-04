// The socket-layer failures a real connection will not perform on cue — a refused or stalled
// write, a failed handshake, and the ciphertext and lifecycle events Bun keeps firing at the RAW
// socket after `upgradeTLS` (oven-sh/bun#26297) — driven by hand against `smtpStreamOver` with the
// runtime injected. The real-listener half lives in `bun-smtp-stream.test.ts`; a completed TLS
// handshake needs a certificate authority and is `driver-smtp.test.ts`'s end-to-end proof.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type SmtpEnvelope, type SmtpSessionOptions, smtpDeliver } from './smtp-client';
import { authPlain } from './smtp-protocol';
import {
  type BunConnect,
  type SocketHandlers,
  type SocketLike,
  smtpStreamOver,
} from './smtp-socket';

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

// Which write answers with which reply; an answer may arrive as several chunks.
type Script = readonly (readonly [RegExp, string | readonly string[]])[];

const FAKE_TARGET = { host: 'mail.example.test', port: 587, tls: false, timeoutMs: 2_000 };

const ENVELOPE: SmtpEnvelope = {
  from: 'no-reply@postly.test',
  recipients: ['ada@example.test'],
  data: 'Subject: hi\r\n\r\nbody line\r\n',
};

const SESSION: SmtpSessionOptions = {
  clientName: 'postly.test',
  secure: false,
  allowInsecure: false,
  timeoutMs: 500,
  user: 'ada',
  password: 'hunter2',
};

// Both EHLOs answer with capabilities split across chunks, so the reader reassembles them.
const EHLO_FRAGMENTS: readonly string[] = [
  '250-mail.example.test ESMTP\r\n250-STARTTLS\r\n250 AUTH',
  ' PLAIN\r\n',
];

const DELIVERY: Script = [
  [/^MAIL FROM:/, '250 2.1.0 Ok\r\n'],
  [/^RCPT TO:/, '250 2.1.5 Ok\r\n'],
  [/^DATA\r\n$/, '354 End data with <CR><LF>.<CR><LF>\r\n'],
  [/\r\n\.\r\n$/, '250 2.0.0 Ok: queued as ABC123\r\n'],
  [/^QUIT/, '221 2.0.0 Bye\r\n'],
];

// Ciphertext Bun keeps firing at the raw socket, carrying a reply the parser would misread.
const RAW_CIPHERTEXT = '\u0017\u0003\u0003\x00\x10not tls\r\n250 AUTH PLAIN\r\n';

/** A SocketLike with its own write/end records, answering writes through the runtime's script. */
class FakeSocket implements SocketLike {
  readonly written: string[] = [];
  ended = false;
  refuseWrites = false;
  stallWrites = false;
  /** Bytes the next write accepts before backpressure; 0 accepts everything. */
  partialWrite = 0;

  constructor(private readonly runtime: FakeRuntime) {}

  write(data: Uint8Array): number {
    if (this.refuseWrites) return -1;
    const text = new TextDecoder().decode(data);
    this.written.push(text);
    if (this.stallWrites) return 0;
    // Backpressure: part of the buffer is accepted, the rest only after a `drain` — no reply yet.
    if (this.partialWrite > 0 && data.length > this.partialWrite) {
      const accepted = this.partialWrite;
      this.partialWrite = 0;
      return accepted;
    }
    this.runtime.answer(text);
    return data.length;
  }

  end(): void {
    this.ended = true;
  }

  upgradeTLS(options: {
    readonly tls: { readonly serverName: string };
    readonly socket: SocketHandlers;
  }): readonly SocketLike[] {
    this.runtime.upgradeEvents = options.socket;
    return this.runtime.tlsSockets(this);
  }
}

/**
 * A `BunConnect` whose sockets answer a script, so a test fires every event by hand. `rawEvents()`
 * is the RAW socket's handler set — the one Bun keeps feeding ciphertext and lifecycle events
 * after `upgradeTLS` (oven-sh/bun#26297); `events()` is the live side's. The upgrade hands back
 * the same socket twice by default; the upgrade tests override it with a distinct TLS socket.
 */
class FakeRuntime implements BunConnect {
  readonly socket: FakeSocket = new FakeSocket(this);
  readonly tlsSocket: FakeSocket = new FakeSocket(this);
  tlsSockets: (raw: SocketLike) => readonly SocketLike[] = (raw) => [raw, raw];
  script: Script = [];
  /** Runs before the scripted reply — where a test installs the raw-socket noise. */
  onCommand: ((command: string) => void) | undefined;
  connectEvents: SocketHandlers | undefined;
  upgradeEvents: SocketHandlers | undefined;

  constructor(options: { readonly distinctTls?: boolean } = {}) {
    if (options.distinctTls === true) this.tlsSockets = (raw) => [raw, this.tlsSocket];
  }

  connect(options: { readonly socket: SocketHandlers }): Promise<SocketLike> {
    this.connectEvents = options.socket;
    return Promise.resolve(this.socket);
  }

  events(): SocketHandlers | undefined {
    return this.upgradeEvents ?? this.connectEvents;
  }

  rawEvents(): SocketHandlers | undefined {
    return this.connectEvents;
  }

  /** The socket the conversation currently runs on: the TLS side once an upgrade was handed in. */
  private liveSocket(): SocketLike {
    return this.upgradeEvents !== undefined ? this.tlsSocket : this.socket;
  }

  /** The server speaks on the live side: plaintext before the upgrade, TLS bytes after it. */
  deliver(text: string): void {
    this.events()?.data(this.liveSocket(), new TextEncoder().encode(text));
  }

  /** The retired raw socket speaks: ciphertext wearing a reply, and its own lifecycle events. */
  pushRaw(text: string): void {
    this.rawEvents()?.data(this.socket, new TextEncoder().encode(text));
  }

  rawClose(): void {
    this.rawEvents()?.close();
  }

  rawEnd(): void {
    this.rawEvents()?.end();
  }

  rawError(message: string): void {
    this.rawEvents()?.error(this.socket, new Error(message));
  }

  liveError(message: string): void {
    this.events()?.error(this.liveSocket(), new Error(message));
  }

  /** A write landed: run the test's noise hook, then answer from the script, fragments in order. */
  answer(text: string): void {
    this.onCommand?.(text);
    const rule = this.script.find(([pattern]) => pattern.test(text));
    if (rule === undefined) return;
    for (const chunk of Array.isArray(rule[1]) ? rule[1] : [rule[1]]) this.deliver(chunk);
  }
}

/** Everything Bun keeps firing at the retired raw socket in the middle of a live conversation. */
const fireRawNoise = (runtime: FakeRuntime): void => {
  runtime.rawClose();
  runtime.rawEnd();
  runtime.rawError('read ECONNRESET');
  runtime.pushRaw(RAW_CIPHERTEXT);
};

test('after the upgrade the retired raw socket is noise: no ciphertext, and TLS fragments assemble', async () => {
  const runtime = new FakeRuntime({ distinctTls: true });
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.deliver('220 mail.example.test ESMTP\r\n');
  expect(await stream.read()).toBe('220 mail.example.test ESMTP\r\n');

  await stream.startTls();

  fireRawNoise(runtime);
  // Nothing landed: `buffered()` is what `assertNothingAfterStarttls` reads, so a byte of the
  // retired socket surfacing here would refuse every healthy session.
  expect(stream.buffered?.()).toBe(false);

  runtime.deliver('250-mail.example.test ESMTP\r\n');
  runtime.deliver('250 AUTH PLAIN\r\n');
  expect(stream.buffered?.()).toBe(true);
  const first = await stream.read();
  const second = await stream.read();
  expect(`${first}${second}`).toBe('250-mail.example.test ESMTP\r\n250 AUTH PLAIN\r\n');
});

test('over an upgraded stream, AUTH 235 completes envelope and DATA while the raw socket is noise', async () => {
  const runtime = new FakeRuntime({ distinctTls: true });
  runtime.script = [
    [/^EHLO /, EHLO_FRAGMENTS],
    [/^STARTTLS/, '220 2.0.0 Ready to start TLS\r\n'],
    [/^AUTH PLAIN /, '235 2.7.0 Authentication successful\r\n'],
    ...DELIVERY,
  ];
  runtime.onCommand = (command) => {
    if (command.startsWith('AUTH PLAIN ')) fireRawNoise(runtime);
  };
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.deliver('220 mail.example.test ESMTP\r\n');

  const reply = await smtpDeliver(stream, ENVELOPE, SESSION);

  expect(reply.code).toBe(250);
  expect(reply.text).toContain('queued as ABC123');
  const commands = runtime.tlsSocket.written.map((line) => line.replace(/\r\n$/, ''));
  expect(commands).toEqual([
    'EHLO postly.test',
    `AUTH PLAIN ${authPlain('ada', 'hunter2')}`,
    'MAIL FROM:<no-reply@postly.test>',
    'RCPT TO:<ada@example.test>',
    'DATA',
    'Subject: hi\r\n\r\nbody line\r\n.',
    'QUIT',
  ]);
  // The cleartext half carried exactly the plaintext commands, nothing after the upgrade.
  expect(runtime.socket.written).toEqual(['EHLO postly.test\r\n', 'STARTTLS\r\n']);
});

test('a 535 over the upgraded stream surfaces the server refusal, not a dead connection', async () => {
  const runtime = new FakeRuntime({ distinctTls: true });
  runtime.script = [
    [/^EHLO /, EHLO_FRAGMENTS],
    [/^STARTTLS/, '220 2.0.0 Ready to start TLS\r\n'],
    [/^AUTH PLAIN /, '535 5.7.8 Authentication credentials invalid\r\n'],
  ];
  runtime.onCommand = (command) => {
    if (command.startsWith('AUTH PLAIN ')) fireRawNoise(runtime);
  };
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.deliver('220 mail.example.test ESMTP\r\n');

  const error = await caught(smtpDeliver(stream, ENVELOPE, SESSION));

  // The noise must not bury the rejection under a closed connection or an expired deadline: the
  // server's own 535 is the diagnosis, and a permanent one.
  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('auth');
  expect(metaOf(error)['status']).toBe(535);
  expect(metaOf(error)['retryable']).toBe(false);
  expect(causeOf(error)).toContain('Authentication credentials invalid');
});

test('raw close, end and error after the upgrade leave the TLS conversation readable', async () => {
  const runtime = new FakeRuntime({ distinctTls: true });
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.deliver('220 mail.example.test ESMTP\r\n');
  expect(await stream.read()).toContain('220');
  await stream.startTls();
  runtime.deliver('250 ok\r\n'); // the first TLS byte closes the STARTTLS handshake window
  expect(await stream.read()).toBe('250 ok\r\n');

  // A reader parks first, then the retired socket dies its own death: the parked read is answered
  // by the next TLS byte, never by the raw side's goodbye.
  const pending = stream.read();
  runtime.rawClose();
  runtime.rawEnd();
  runtime.rawError('read ECONNRESET');
  runtime.pushRaw('221 raw farewell\r\n');
  runtime.deliver('250 still here\r\n');

  expect(await pending).toBe('250 still here\r\n');
});

test('an error on the live TLS socket propagates in both handshake windows', async () => {
  const inWindow = new FakeRuntime({ distinctTls: true });
  const starttls = await smtpStreamOver(inWindow, FAKE_TARGET);
  inWindow.deliver('220 mail.example.test ESMTP\r\n');
  expect(await starttls.read()).toContain('220');
  await starttls.startTls();
  inWindow.liveError('certificate has expired');
  const refused = await caught(starttls.read());
  expect(codeOf(refused)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(refused)['stage']).toBe('starttls');
  expect(metaOf(refused)['retryable']).toBe(false);

  // After the first byte back the window is closed: the same error is a transient data failure.
  const afterByte = new FakeRuntime({ distinctTls: true });
  const data = await smtpStreamOver(afterByte, FAKE_TARGET);
  afterByte.deliver('220 mail.example.test ESMTP\r\n');
  expect(await data.read()).toContain('220');
  await data.startTls();
  afterByte.deliver('250 ok\r\n');
  expect(await data.read()).toBe('250 ok\r\n');
  fireRawNoise(afterByte);
  afterByte.liveError('read ECONNRESET');
  const transient = await caught(data.read());
  expect(metaOf(transient)['stage']).toBe('data');
  expect(metaOf(transient)['retryable']).toBe(true);
});

test('a failure inside the implicit-TLS handshake window is a refused handshake, not a retry', async () => {
  const errored = new FakeRuntime();
  const refusedStream = await smtpStreamOver(errored, { ...FAKE_TARGET, tls: true });
  errored.liveError('certificate has expired');
  const refused = await caught(refusedStream.read());
  expect(codeOf(refused)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(refused)['stage']).toBe('tls');
  expect(metaOf(refused)['retryable']).toBe(false);
  expect(causeOf(refused)).toContain('certificate has expired');

  const halfClosed = new FakeRuntime();
  const endedStream = await smtpStreamOver(halfClosed, { ...FAKE_TARGET, tls: true });
  halfClosed.rawEnd();
  const eof = await caught(endedStream.read());
  expect(metaOf(eof)['stage']).toBe('tls');
  expect(causeOf(eof)).toContain('half-closed');
});

test('a socket that refuses a write fails it at once instead of parking for a drain', async () => {
  const runtime = new FakeRuntime();
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.socket.refuseWrites = true;

  const error = await caught(stream.write('EHLO postly.test\r\n'));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('data');
  expect(metaOf(error)['retryable']).toBe(true);
  expect(causeOf(error)).toContain('refused a 18-byte write');
});

test('a socket that never drains hits the write deadline instead of holding the worker', async () => {
  const runtime = new FakeRuntime();
  const stream = await smtpStreamOver(runtime, { ...FAKE_TARGET, timeoutMs: 20 });
  runtime.socket.stallWrites = true;

  const error = await caught(stream.write('EHLO postly.test\r\n'));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('data');
  expect(metaOf(error)['retryable']).toBe(true);
  expect(causeOf(error)).toContain('stopped accepting bytes for 20ms');
});

test('a partial write waits for drain, then lands the rest', async () => {
  const runtime = new FakeRuntime();
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.socket.partialWrite = 4;

  const flushed = stream.write('EHLO postly.test\r\n');
  runtime.events()?.drain();

  await flushed;
  // The second call carried exactly the unsent remainder — the accepted 4 bytes were 'EHLO'.
  expect(runtime.socket.written).toEqual(['EHLO postly.test\r\n', ' postly.test\r\n']);
});

test('a parked write is failed at once by a live socket error, not at the deadline', async () => {
  const runtime = new FakeRuntime();
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.socket.stallWrites = true;

  const parked = caught(stream.write('EHLO postly.test\r\n'));
  runtime.liveError('read ECONNRESET');

  const error = await parked;
  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('data');
  expect(metaOf(error)['retryable']).toBe(true);
  // The socket error is the diagnosis; the deadline's wording would mean `failDrain` never ran.
  expect(causeOf(error)).toContain('read ECONNRESET');
});

test('close ends the socket the conversation currently runs on', async () => {
  const runtime = new FakeRuntime({ distinctTls: true });
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.deliver('220 mail.example.test ESMTP\r\n');
  expect(await stream.read()).toContain('220');
  await stream.startTls();

  stream.close();

  expect(runtime.tlsSocket.ended).toBe(true);
  expect(runtime.socket.ended).toBe(false);
});

test('an upgrade that returns no TLS socket is refused, and the raw socket stays live', async () => {
  const runtime = new FakeRuntime();
  runtime.tlsSockets = (raw) => [raw];
  const stream = await smtpStreamOver(runtime, FAKE_TARGET);
  runtime.deliver('220 mail.example.test ESMTP\r\n');
  expect(await stream.read()).toContain('220');

  const error = await caught(stream.startTls());

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('starttls');
  expect(metaOf(error)['retryable']).toBe(false);
  expect(fixOf(error)).toContain('upgrade the runtime');
  // Nothing was upgraded, so the raw socket's handlers are still the live ones.
  runtime.pushRaw('250 still in the clear\r\n');
  expect(await stream.read()).toBe('250 still in the clear\r\n');
});
