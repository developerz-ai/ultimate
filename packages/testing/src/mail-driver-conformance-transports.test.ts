// The mail-driver suite over the three production transports, each run for real over a fake wire
// (`mail-driver-conformance-fixture.ts`), and the wire facts the port cannot ask: `send()` refuses a
// header break before ANY driver dials, and a retried message carries one identity on the wire.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { resetJobDriver } from '@ultimat3/jobs/adapter';
import { blocks, defineMail, mailIdempotencyKey, renderMessage, send } from '@ultimat3/mail';
import type { MailDriver } from '@ultimat3/mail/adapter';
import { installMailDriver, resetMailDriver } from '@ultimat3/mail/adapter';
import { t } from '@ultimat3/schema';
import { mailDriverConformance } from './mail-driver-conformance';
import { resendProbe, sesProbe, smtpProbe } from './mail-driver-conformance-fixture';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the smtp mail driver, over a fake session'), () => {
  behavesLike(mailDriverConformance, () => smtpProbe().driver);
});

describe(testName('unit', 'the resend mail driver, over a fake fetch'), () => {
  behavesLike(mailDriverConformance, () => resendProbe().driver);
});

describe(testName('unit', 'the ses mail driver, over a fake fetch'), () => {
  behavesLike(mailDriverConformance, () => sesProbe().driver);
});

const TO = 'ada@example.test';

registerCatalog(
  'en',
  loadCatalog({
    conformance: {
      basic: { subject: 'Hi {name}', heading: 'Hello {name}', body: 'Your invite is waiting.' },
    },
  }),
);

const basicMail = defineMail<{ name: string }>({
  id: 'conformance-basic',
  subject: 'conformance.basic.subject',
  input: t.object({ name: t.string }),
  template: ({ data }) => [
    blocks.heading('conformance.basic.heading', { name: data.name }),
    blocks.paragraph('conformance.basic.body'),
  ],
});

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

/** `<driver name>:<verdict>`, so a failing expectation names which side moved. */
async function outcome(driver: MailDriver, name: string): Promise<string> {
  installMailDriver(driver);
  const verdict = await send(basicMail, { name }, { to: TO, locale: 'en', sync: true }).then(
    () => 'ok',
    (error: unknown) => codeOf(error),
  );
  return `${driver.name}:${verdict}`;
}

describe(testName('unit', 'mail on the wire, whichever transport'), () => {
  beforeEach(() => {
    resetMailDriver();
    // `send` enqueues whenever a job driver is ambient; these cases are about the transports.
    resetJobDriver();
  });

  // The rule is a property of the MESSAGE, not of a wire format: `send()` holds it, ahead of every
  // driver, so none can be the one that lets a header through.
  test('a line break in the subject is refused for every transport, and none dials', async () => {
    const [smtp, resend, ses] = [smtpProbe(), resendProbe(), sesProbe()];
    const poison = 'Ada\r\nBcc: evil@example.test';
    const verdicts = [
      await outcome(smtp.driver, poison),
      await outcome(resend.driver, poison),
      await outcome(ses.driver, poison),
    ];
    expect(verdicts).toEqual([
      'smtp:X_MAIL_HEADER_INVALID',
      'resend:X_MAIL_HEADER_INVALID',
      'ses:X_MAIL_HEADER_INVALID',
    ]);
    expect([smtp.sessions, resend.requests, ses.requests]).toEqual([[], [], []]);
  });

  // The control: one character different, and every wire is reached with the same subject.
  test('the same send without the break reaches every wire', async () => {
    const [smtp, resend, ses] = [smtpProbe(), resendProbe(), sesProbe()];
    const verdicts = [
      await outcome(smtp.driver, 'Ada'),
      await outcome(resend.driver, 'Ada'),
      await outcome(ses.driver, 'Ada'),
    ];
    expect(verdicts).toEqual(['smtp:ok', 'resend:ok', 'ses:ok']);
    expect(smtp.bodies[0]).toContain('Subject: Hi Ada');
    expect(resend.requests[0]?.body['subject']).toBe('Hi Ada');
    expect(ses.requests).toHaveLength(1);
  });

  // A retry after a timeout past `DATA` must be collapsible by the receiving mailbox: SMTP's one
  // handle is the Message-ID, Resend's the header the provider honours.
  test('a repeated send carries one identity on the wire', async () => {
    const [smtp, resend] = [smtpProbe(), resendProbe()];
    const message = renderMessage(basicMail, { name: 'Ada' }, { to: TO, locale: 'en' });

    const first = await smtp.driver.send(message);
    const second = await smtp.driver.send(message);
    await resend.driver.send(message);
    await resend.driver.send(message);

    expect(second.id).toBe(first.id);
    expect(smtp.bodies[1]).toContain(`Message-ID: ${first.id}`);
    expect(resend.requests.map((one) => one.headers.get('Idempotency-Key'))).toEqual([
      mailIdempotencyKey(message),
      mailIdempotencyKey(message),
    ]);
  });

  // The key travels verbatim to Resend over TLS, never into the Message-ID every recipient reads.
  test('the Message-ID is a one-way digest of the key, recognisable by its template id', async () => {
    const smtp = smtpProbe();
    const message = renderMessage(
      basicMail,
      { name: 'Ada' },
      { to: TO, locale: 'en', bcc: ['ops@example.test'] },
    );
    const result = await smtp.driver.send(message);
    expect(result.id).not.toContain(mailIdempotencyKey(message));
    expect(result.id.startsWith('<conformance-basic.')).toBe(true);
  });
});
