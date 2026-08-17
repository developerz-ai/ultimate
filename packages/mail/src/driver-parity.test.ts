// One question, one answer, whichever transport is asked. Both production drivers run FOR REAL
// here — the SMTP one over a fake `SmtpStream`, the Resend one over a fake `fetch` — so each case
// compares what a driver actually did rather than a proxy for it, and both sides are asserted
// inside one `test()` so neither can move alone.
//
// The memory driver is in the cases about the MESSAGE and in none of the cases about a wire. It
// dials nothing, maps no status and carries no idempotency header: holding it to a transport
// contract would be a parity claim nobody can keep. That is a documented difference, not a defect.

import { beforeEach, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { resetJobDriver } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { blocks } from './blocks';
import { registerMailCatalog } from './catalog';
import type { MailDriver } from './driver';
import { createMemoryDriver, resetMailDriver, setMailDriver } from './driver';
import { createResendDriver, type MailFetch } from './driver-resend';
import { createSmtpDriver } from './driver-smtp';
import { mailIdempotencyKey } from './idempotency';
import { defineMail, renderMessage, send } from './mail';
import type { SmtpConnector, SmtpStream } from './smtp-client';

const FROM = 'Postly <no-reply@postly.test>';
const TO = 'ada@example.test';

registerMailCatalog('en');
registerCatalog(
  'en',
  loadCatalog({
    parity: {
      basic: {
        subject: 'Hi {name}',
        heading: 'Hello {name}',
        body: 'Your invite is waiting.',
      },
    },
  }),
);

const parityMail = defineMail<{ name: string }>({
  id: 'parity-basic',
  subject: 'parity.basic.subject',
  input: t.object({ name: t.string }),
  template: ({ data }) => [
    blocks.heading('parity.basic.heading', { name: data.name }),
    blocks.paragraph('parity.basic.body'),
  ],
});

interface SmtpProbe {
  readonly driver: MailDriver;
  /** One entry per dial: the command lines that session saw. A refusal before the wire leaves it empty. */
  readonly sessions: string[][];
  /** The raw MIME each accepted `DATA` carried. */
  readonly bodies: string[];
}

/**
 * The smallest thing that is still an SMTP server, over the driver's own `SmtpConnector` seam:
 * greeting, EHLO, envelope, `DATA` framed by `\r\n.\r\n`. `smtps://` so the session is secure from
 * the first byte and no STARTTLS or AUTH step is in the way of what these cases are about.
 */
function smtpProbe(): SmtpProbe {
  const sessions: string[][] = [];
  const bodies: string[] = [];

  const connect: SmtpConnector = () => {
    const lines: string[] = [];
    sessions.push(lines);
    const replies: string[] = ['220 fake.test ESMTP\r\n'];
    let inData = false;
    let buffer = '';

    const stream: SmtpStream = {
      read: () => Promise.resolve(replies.shift()),
      write(chunk: string): Promise<void> {
        buffer += chunk;
        for (;;) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end === -1) break;
            bodies.push(buffer.slice(0, end));
            buffer = buffer.slice(end + 5);
            inData = false;
            replies.push('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          const eol = buffer.indexOf('\r\n');
          if (eol === -1) break;
          const line = buffer.slice(0, eol);
          buffer = buffer.slice(eol + 2);
          lines.push(line);
          if (line.startsWith('EHLO')) replies.push('250-fake.test\r\n250 SIZE 20000000\r\n');
          else if (line === 'DATA') {
            inData = true;
            replies.push('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (line === 'QUIT') replies.push('221 2.0.0 Bye\r\n');
          else replies.push('250 2.0.0 Ok\r\n');
        }
        return Promise.resolve();
      },
      startTls: () => Promise.resolve(),
      close: () => undefined,
    };
    return Promise.resolve(stream);
  };

  return {
    sessions,
    bodies,
    driver: createSmtpDriver({ url: 'smtps://fake.test:465', from: FROM, connect }),
  };
}

interface ResendRequest {
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

interface ResendProbe {
  readonly driver: MailDriver;
  /** One entry per POST. A refusal before the wire leaves it empty. */
  readonly requests: ResendRequest[];
}

/** The Resend half of the same seam: `options.fetch`, so the sealed test network is never touched. */
function resendProbe(): ResendProbe {
  const requests: ResendRequest[] = [];
  const fetch: MailFetch = (_input, init) => {
    requests.push({
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'resend_fake_id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return {
    requests,
    driver: createResendDriver({ apiKey: 'resend_sk_parity', from: FROM, fetch }),
  };
}

function codeOf(value: unknown): string {
  return isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;
}

/** `<driver name>:<verdict>`, so a failing expectation names which side moved. */
async function outcome(driver: MailDriver, name: string): Promise<string> {
  setMailDriver(driver);
  const verdict = await send(parityMail, { name }, { to: TO, locale: 'en', sync: true }).then(
    () => 'ok',
    (error: unknown) => codeOf(error),
  );
  return `${driver.name}:${verdict}`;
}

beforeEach(() => {
  resetMailDriver();
  // `send` enqueues whenever a job driver is ambient and the driver is process-global; these cases
  // are about the transports, so the inline path is stated rather than inherited.
  resetJobDriver();
});

// A8. The rule is a property of the MESSAGE, not of a wire format — `mime.ts` held the only copy,
// so a subject an SMTP deploy refused was accepted by memory in dev and by Resend in staging.
test('a line break in the subject is refused by every driver, and none of them dials', async () => {
  const smtp = smtpProbe();
  const resend = resendProbe();
  const poison = 'Ada\r\nBcc: evil@example.test';

  const verdicts = [
    await outcome(createMemoryDriver(), poison),
    await outcome(smtp.driver, poison),
    await outcome(resend.driver, poison),
  ];

  // Named absolutely as well as compared: equality alone is satisfied by three drivers failing for
  // three different reasons, or by all three failing at something else entirely.
  expect(verdicts).toEqual([
    'memory:X_MAIL_HEADER_INVALID',
    'smtp:X_MAIL_HEADER_INVALID',
    'resend:X_MAIL_HEADER_INVALID',
  ]);
  // And refused BEFORE the wire on both transports: a driver that refused after writing would
  // already have injected the header it was refusing.
  expect(smtp.sessions).toEqual([]);
  expect(resend.requests).toEqual([]);
});

// The control that makes the case above mean something: the same send, one character different,
// reaches both wires. Without it "every driver refuses" is satisfied by every driver being broken.
test('the same send without the break reaches both wires with the same subject', async () => {
  const smtp = smtpProbe();
  const resend = resendProbe();

  const verdicts = [
    await outcome(createMemoryDriver(), 'Ada'),
    await outcome(smtp.driver, 'Ada'),
    await outcome(resend.driver, 'Ada'),
  ];

  expect(verdicts).toEqual(['memory:ok', 'smtp:ok', 'resend:ok']);
  expect(smtp.bodies).toHaveLength(1);
  expect(smtp.bodies[0]).toContain('Subject: Hi Ada');
  expect(resend.requests).toHaveLength(1);
  expect(resend.requests[0]?.body['subject']).toBe('Hi Ada');
});

// A9. Both transports report the same `SendResult.idempotencyKey`, so both owe a stable identity
// on the wire for the same message. Resend has always sent one; SMTP minted a fresh Message-ID per
// attempt, which made a retry after a timeout past `DATA` a second email to every mailbox.
test('a repeated send carries one identity on both transports', async () => {
  const smtp = smtpProbe();
  const resend = resendProbe();
  const message = renderMessage(parityMail, { name: 'Ada' }, { to: TO, locale: 'en' });

  const first = await smtp.driver.send(message);
  const second = await smtp.driver.send(message);
  await resend.driver.send(message);
  await resend.driver.send(message);

  // SMTP: the Message-ID is the ONE identifier a receiving mailbox can collapse a duplicate on,
  // and it is what the driver reports as `SendResult.id`.
  expect(second.id).toBe(first.id);
  expect(smtp.bodies).toHaveLength(2);
  expect(smtp.bodies[1]).toContain(`Message-ID: ${first.id}`);
  // Resend: the same guarantee through the header the provider itself honours.
  expect(resend.requests.map((one) => one.headers.get('Idempotency-Key'))).toEqual([
    mailIdempotencyKey(message),
    mailIdempotencyKey(message),
  ]);
});

// The half of A9 that is a transport DIFFERENCE and not a defect, pinned so it cannot be "fixed"
// into a leak: the key travels verbatim to Resend, which reads it over TLS, and never into the
// Message-ID, which every recipient of the mail can read — the key holds the recipient list.
test('the Message-ID is a one-way digest of the key, never the key', async () => {
  const smtp = smtpProbe();
  const message = renderMessage(
    parityMail,
    { name: 'Ada' },
    { to: TO, locale: 'en', bcc: ['ops@example.test'] },
  );

  const result = await smtp.driver.send(message);

  expect(result.id).not.toContain(mailIdempotencyKey(message));
  expect(result.id).not.toContain(TO);
  expect(result.id).not.toContain('ops@example.test');
  // Still recognisable to an operator reading a mail log: the template id, then the digest.
  expect(result.id.startsWith('<parity-basic.')).toBe(true);
});
