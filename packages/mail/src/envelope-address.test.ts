// Tests for the envelope-address gate. The load-bearing one is the INLINE send path — no schema
// runs there, so a `bcc` carrying a CRLF used to reach `RCPT TO:` by interpolation. It asserts on
// the bytes the client wrote, not on the throw: a refusal raised after the envelope was already
// on the wire would satisfy a weaker test and still have relayed the attacker's mail.

import { beforeEach, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { resetJobDriver } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { blocks } from './blocks';
import { registerMailCatalog } from './catalog';
import { resetMailDriver, setMailDriver } from './driver';
import { createSmtpDriver } from './driver-smtp';
import { assertEnvelopeAddress } from './envelope-address';
import { defineMail, send } from './mail';
import { type SmtpSessionOptions, type SmtpStream, smtpDeliver } from './smtp-client';

registerMailCatalog();
registerCatalog(
  'en',
  loadCatalog({
    'envelope-address': { subject: 'Hi {name}', heading: 'Hello {name}', body: 'Body.' },
  }),
);

const injectionMail = defineMail<{ name: string }>({
  id: 'test-envelope-address',
  subject: 'envelope-address.subject',
  input: t.object({ name: t.string }),
  template: ({ data }) => [
    blocks.heading('envelope-address.heading', { name: data.name }),
    blocks.paragraph('envelope-address.body'),
  ],
});

const SESSION: SmtpSessionOptions = {
  clientName: 'postly.test',
  secure: true,
  allowInsecure: false,
  timeoutMs: 500,
};

/** A server that says yes to everything, so only the client's own refusals can stop a send. */
class AgreeableStream implements SmtpStream {
  readonly written: string[] = [];
  private readonly outbox = ['220 mail.example.test ESMTP\r\n'];

  read(): Promise<string | undefined> {
    return Promise.resolve(this.outbox.shift());
  }

  write(data: string): Promise<void> {
    this.written.push(data);
    if (data.startsWith('EHLO')) this.outbox.push('250-mail.example.test\r\n250 SIZE 100000\r\n');
    else if (data === 'DATA\r\n') this.outbox.push('354 go ahead\r\n');
    else this.outbox.push('250 2.0.0 Ok\r\n');
    return Promise.resolve();
  }

  startTls(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}

  /** Everything that crossed the socket, as one string — the wire, exactly as a server reads it. */
  wire(): string {
    return this.written.join('');
  }
}

function codeOf(value: unknown): string {
  return isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  resetMailDriver();
  // `send` enqueues whenever a job driver is ambient, and the queued path parses the envelope
  // through `mailMessageSchema`. These tests are about the path where nothing parses it.
  resetJobDriver();
});

test('an inline send cannot smuggle a second RCPT TO through bcc', async () => {
  const stream = new AgreeableStream();
  setMailDriver(
    createSmtpDriver({
      url: 'smtps://mail.example.test:465',
      from: 'Postly <no-reply@postly.test>',
      timeoutMs: 500,
      connect: () => Promise.resolve(stream),
    }),
  );

  const error = await caught(
    send(
      injectionMail,
      { name: 'Ada' },
      {
        to: ['ada@example.test'],
        locale: 'en',
        tz: 'UTC',
        sync: true,
        bcc: ['ops@example.test\r\nRCPT TO:<attacker@evil.test>'],
      },
    ),
  );

  expect(codeOf(error)).toBe('X_MAIL_ADDRESS_INVALID');
  // The assertion that matters: the attacker's address never became bytes on the connection.
  expect(stream.wire()).not.toContain('attacker@evil.test');
  expect(stream.wire()).not.toContain('ops@example.test');
});

test('the envelope sender is gated too, whoever built the envelope', async () => {
  const stream = new AgreeableStream();

  const error = await caught(
    smtpDeliver(
      stream,
      {
        from: 'no-reply@postly.test\r\nMAIL FROM:<spoof@evil.test>',
        recipients: ['ada@example.test'],
        data: 'Subject: hi\r\n\r\nbody\r\n',
      },
      SESSION,
    ),
  );

  expect(codeOf(error)).toBe('X_MAIL_ADDRESS_INVALID');
  expect(stream.wire()).not.toContain('spoof@evil.test');
});

test('refuses every character that could restructure the command line', () => {
  const refused = [
    'ada@example.test\r\nDATA',
    'ada@example.test\nQUIT',
    'ada@example.test\rQUIT',
    'ada@example.test> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;evil@evil.test',
    '<ada@example.test>',
    'ada@example.test\tx',
  ];
  for (const address of refused) {
    expect(() => assertEnvelopeAddress('recipient', address)).toThrow();
  }
});

test('leaves a legitimate address alone, including a quoted local part', () => {
  for (const address of ['ada@example.test', 'josé@exämple.test', '"ada lovelace"@example.test']) {
    expect(() => assertEnvelopeAddress('recipient', address)).not.toThrow();
  }
});

test('the refusal names the half of the envelope it came from, never the address', () => {
  const error = caughtSync(() => assertEnvelopeAddress('sender', 'a@b.test\r\nQUIT'));

  expect(codeOf(error)).toBe('X_MAIL_ADDRESS_INVALID');
  expect(isUltimateError(error) ? error.meta : undefined).toEqual({ field: 'sender' });
  // Recipient data stays out of every string this package writes itself.
  expect(isUltimateError(error) ? `${error.cause} ${error.fix}` : '').not.toContain('a@b.test');
});

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
