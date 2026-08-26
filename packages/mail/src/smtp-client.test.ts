// Tests for the SMTP conversation, driven by a scripted stream: every branch — STARTTLS, both
// AUTH mechanisms, a greylist, a hard bounce, a dropped connection, a stalled server — without a
// socket. What the client wrote is asserted verbatim, because the wire IS the contract here.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  type SmtpEnvelope,
  type SmtpSessionOptions,
  type SmtpStream,
  smtpDeliver,
} from './smtp-client';

const ENVELOPE: SmtpEnvelope = {
  from: 'no-reply@postly.test',
  recipients: ['ada@example.test', 'grace@example.test'],
  data: 'Subject: hi\r\n\r\nbody line\r\n',
};

const SESSION: SmtpSessionOptions = {
  clientName: 'postly.test',
  secure: true,
  allowInsecure: false,
  timeoutMs: 500,
};

const EHLO_FULL =
  '250-mail.example.test\r\n250-PIPELINING\r\n250-SIZE 35882577\r\n250 AUTH PLAIN LOGIN\r\n';
const EHLO_STARTTLS = '250-mail.example.test\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n';
const EHLO_BARE = '250-mail.example.test\r\n250 SIZE 10000000\r\n';

type Script = readonly (readonly [RegExp, string])[];

/** A server made of rules: the first pattern that matches what the client wrote answers it. */
class ScriptedStream implements SmtpStream {
  readonly written: string[] = [];
  tlsUpgrades = 0;
  closed = false;
  private readonly outbox: string[] = [];

  constructor(
    private readonly script: Script,
    greeting = '220 mail.example.test ESMTP\r\n',
  ) {
    if (greeting !== '') this.outbox.push(greeting);
  }

  read(): Promise<string | undefined> {
    return Promise.resolve(this.outbox.shift());
  }

  write(data: string): Promise<void> {
    this.written.push(data);
    const rule = this.script.find(([pattern]) => pattern.test(data));
    if (rule !== undefined) this.outbox.push(rule[1]);
    return Promise.resolve();
  }

  startTls(): Promise<void> {
    this.tlsUpgrades += 1;
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }

  /** Every command, CRLF stripped — the DATA payload is excluded so assertions stay readable. */
  commands(): string[] {
    return this.written.map((line) => line.replace(/\r\n$/, ''));
  }
}

const DELIVERY: Script = [
  [/^MAIL FROM:/, '250 2.1.0 Ok\r\n'],
  [/^RCPT TO:/, '250 2.1.5 Ok\r\n'],
  [/^DATA\r\n$/, '354 End data with <CR><LF>.<CR><LF>\r\n'],
  [/\r\n\.\r\n$/, '250 2.0.0 Ok: queued as ABC123\r\n'],
  [/^QUIT/, '221 2.0.0 Bye\r\n'],
];

function codeOf(value: unknown): string {
  return isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;
}

function metaOf(value: unknown): Readonly<Record<string, unknown>> {
  return isUltimateError(value) ? (value.meta ?? {}) : {};
}

function causeOf(value: unknown): string {
  return isUltimateError(value) ? value.cause : String(value);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

const decodeBase64 = (encoded: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));

test('an implicit-TLS session walks greeting, EHLO, envelope, DATA and QUIT in order', async () => {
  const stream = new ScriptedStream([[/^EHLO /, EHLO_FULL], ...DELIVERY]);

  const reply = await smtpDeliver(stream, ENVELOPE, SESSION);

  expect(reply.code).toBe(250);
  expect(reply.text).toContain('queued as ABC123');
  expect(stream.commands()).toEqual([
    'EHLO postly.test',
    'MAIL FROM:<no-reply@postly.test>',
    'RCPT TO:<ada@example.test>',
    'RCPT TO:<grace@example.test>',
    'DATA',
    'Subject: hi\r\n\r\nbody line\r\n.',
    'QUIT',
  ]);
  // Already encrypted: STARTTLS must not be attempted, let alone an upgrade performed.
  expect(stream.tlsUpgrades).toBe(0);
});

test('a cleartext session upgrades with STARTTLS and re-issues EHLO', async () => {
  const stream = new ScriptedStream([
    [/^EHLO /, EHLO_STARTTLS],
    [/^STARTTLS/, '220 2.0.0 Ready to start TLS\r\n'],
    [/^AUTH PLAIN /, '235 2.7.0 Authentication successful\r\n'],
    ...DELIVERY,
  ]);

  await smtpDeliver(stream, ENVELOPE, {
    ...SESSION,
    secure: false,
    user: 'ada',
    password: 'hunter2',
  });

  expect(stream.tlsUpgrades).toBe(1);
  const commands = stream.commands();
  // Capabilities are re-read after the upgrade: the pre-TLS ones are not the post-TLS ones.
  expect(commands.filter((line) => line.startsWith('EHLO'))).toHaveLength(2);
  // Presence first: `indexOf` answers -1 for a command that was never sent, and -1 is less than
  // every real index — so a client that silently skipped STARTTLS and sent everything in the
  // clear would read as correctly ordered.
  expect(commands).toContain('STARTTLS');
  expect(commands.indexOf('STARTTLS')).toBeLessThan(commands.lastIndexOf('EHLO postly.test'));
});

test('AUTH PLAIN carries the RFC 4616 payload and never the raw password', async () => {
  const stream = new ScriptedStream([
    [/^EHLO /, EHLO_FULL],
    [/^AUTH PLAIN /, '235 2.7.0 Authentication successful\r\n'],
    ...DELIVERY,
  ]);

  await smtpDeliver(stream, ENVELOPE, { ...SESSION, user: 'ada', password: 'hünter2' });

  const auth = stream.commands().find((line) => line.startsWith('AUTH PLAIN '));
  expect(auth).toBeDefined();
  expect(auth).not.toContain('hünter2');
  expect(decodeBase64((auth ?? '').slice('AUTH PLAIN '.length))).toBe('\0ada\0hünter2');
});

test('AUTH LOGIN is used when the server offers no PLAIN', async () => {
  const stream = new ScriptedStream([
    [/^EHLO /, '250-mail.example.test\r\n250 AUTH LOGIN\r\n'],
    [/^AUTH LOGIN/, '334 VXNlcm5hbWU6\r\n'],
    [/^YWRh/, '334 UGFzc3dvcmQ6\r\n'],
    [/^aHVudGVyMg==/, '235 2.7.0 Authentication successful\r\n'],
    ...DELIVERY,
  ]);

  await smtpDeliver(stream, ENVELOPE, { ...SESSION, user: 'ada', password: 'hunter2' });

  expect(stream.commands()).toContain('AUTH LOGIN');
  expect(stream.commands()).toContain('YWRh');
});

test('a server offering no mechanism this client speaks fails without sending credentials', async () => {
  const stream = new ScriptedStream([[/^EHLO /, '250-mail.example.test\r\n250 AUTH GSSAPI\r\n']]);

  const error = await caught(
    smtpDeliver(stream, ENVELOPE, { ...SESSION, user: 'ada', password: 'hunter2' }),
  );

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('auth');
  expect(metaOf(error)['retryable']).toBe(false);
  expect(causeOf(error)).toContain('GSSAPI');
  expect(stream.written.join('')).not.toContain('hunter2');
});

test('rejected credentials are permanent, not a retry', async () => {
  const stream = new ScriptedStream([
    [/^EHLO /, EHLO_FULL],
    [/^AUTH PLAIN /, '535 5.7.8 Authentication credentials invalid\r\n'],
  ]);

  const error = await caught(
    smtpDeliver(stream, ENVELOPE, { ...SESSION, user: 'ada', password: 'wrong' }),
  );

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('auth');
  expect(metaOf(error)['status']).toBe(535);
  expect(metaOf(error)['retryable']).toBe(false);
});

test('a cleartext server without STARTTLS is refused unless insecure sending is opted into', async () => {
  const error = await caught(
    smtpDeliver(new ScriptedStream([[/^EHLO /, EHLO_BARE]]), ENVELOPE, {
      ...SESSION,
      secure: false,
    }),
  );

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('starttls');
  expect(metaOf(error)['retryable']).toBe(false);
});

test('allowInsecure delivers over a cleartext server that offers no STARTTLS', async () => {
  const stream = new ScriptedStream([[/^EHLO /, EHLO_BARE], ...DELIVERY]);

  const reply = await smtpDeliver(stream, ENVELOPE, {
    ...SESSION,
    secure: false,
    allowInsecure: true,
  });

  expect(reply.code).toBe(250);
  expect(stream.tlsUpgrades).toBe(0);
});

test('a greylisted recipient is transient and a rejected one is permanent', async () => {
  const greylisted = await caught(
    smtpDeliver(
      new ScriptedStream([
        [/^EHLO /, EHLO_FULL],
        [/^MAIL FROM:/, '250 Ok\r\n'],
        [/^RCPT TO:/, '450 4.2.0 Greylisted, try again later\r\n'],
      ]),
      ENVELOPE,
      SESSION,
    ),
  );
  const rejected = await caught(
    smtpDeliver(
      new ScriptedStream([
        [/^EHLO /, EHLO_FULL],
        [/^MAIL FROM:/, '250 Ok\r\n'],
        [/^RCPT TO:/, '550 5.1.1 <ada@example.test>: Recipient address rejected\r\n'],
      ]),
      ENVELOPE,
      SESSION,
    ),
  );

  expect(metaOf(greylisted)['retryable']).toBe(true);
  expect(metaOf(greylisted)['status']).toBe(450);
  expect(metaOf(rejected)['retryable']).toBe(false);
  expect(metaOf(rejected)['stage']).toBe('recipient');
  // The server's own words carry the address it refused; the client adds none of its own.
  expect(causeOf(rejected)).toContain('Recipient address rejected');
});

test('a greeting that is not 220 fails at the greeting, before anything is sent', async () => {
  const stream = new ScriptedStream([], '554 5.7.1 Service unavailable\r\n');

  const error = await caught(smtpDeliver(stream, ENVELOPE, SESSION));

  expect(metaOf(error)['stage']).toBe('greeting');
  expect(metaOf(error)['status']).toBe(554);
  expect(stream.written).toHaveLength(0);
});

test('a connection that closes mid-conversation is transient, not a silent success', async () => {
  const stream = new ScriptedStream([[/^EHLO /, EHLO_FULL]]);

  const error = await caught(smtpDeliver(stream, ENVELOPE, SESSION));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('from');
  expect(metaOf(error)['retryable']).toBe(true);
  expect(causeOf(error)).toContain('closed the connection');
});

test('a server that answers nothing hits the deadline instead of hanging the worker', async () => {
  const silent: SmtpStream = {
    read: () => new Promise(() => undefined),
    write: () => Promise.resolve(),
    startTls: () => Promise.resolve(),
    close: () => undefined,
  };

  const error = await caught(smtpDeliver(silent, ENVELOPE, { ...SESSION, timeoutMs: 20 }));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)['stage']).toBe('greeting');
  expect(metaOf(error)['retryable']).toBe(true);
});

test('a body line of a single dot is stuffed so it cannot end DATA early', async () => {
  const stream = new ScriptedStream([[/^EHLO /, EHLO_FULL], ...DELIVERY]);

  await smtpDeliver(
    stream,
    { ...ENVELOPE, data: 'Subject: hi\r\n\r\n.\r\n.hidden\r\nlast\r\n' },
    SESSION,
  );

  const payload = stream.written.find((line) => line.includes('Subject: hi')) ?? '';
  expect(payload).toContain('\r\n..\r\n..hidden\r\nlast\r\n.\r\n');
  // Exactly one terminator: the trailing CRLF of the body must not leave a blank line before it.
  expect(payload.split('\r\n.\r\n')).toHaveLength(2);
});

test('a reply split across several chunks is still read as one reply', async () => {
  const dribbling: SmtpStream = {
    read: (): Promise<string | undefined> => Promise.resolve(chunks.shift()),
    write: () => Promise.resolve(),
    startTls: () => Promise.resolve(),
    close: () => undefined,
  };
  const chunks = [
    '22',
    '0 mail.example',
    '.test ESMTP\r\n25',
    '0-mail\r\n250 OK\r',
    '\n250 Ok\r\n',
  ];

  // Greeting and EHLO both arrive in pieces; reaching MAIL FROM at all proves the framing held.
  const error = await caught(smtpDeliver(dribbling, ENVELOPE, SESSION));

  expect(metaOf(error)['stage']).toBe('recipient');
});
