import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { JobRunArgs } from '@ultimat3/jobs';
import type { MailMessage } from './driver';
import { resetMailDriver, setMailDriver } from './driver';
import { driverUnavailable } from './errors';
import { mailIdempotencyKey } from './idempotency';
import { sendMailJob } from './job';
import { renderMessage, type SendOptions } from './mail';
import { welcomeMail } from './templates';

const TO: SendOptions = { to: 'ada@example.test', locale: 'en', tz: 'UTC' };

const PAYLOAD = { name: 'Ada', appName: 'Acme', url: 'https://acme.test/app' };

test('the same mail, recipient and payload produce the same idempotency key', () => {
  const first = mailIdempotencyKey(renderMessage(welcomeMail, PAYLOAD, TO));
  const second = mailIdempotencyKey(renderMessage(welcomeMail, PAYLOAD, TO));

  expect(first).toBe(second);
  expect(first.startsWith('mail:welcome:ada@example.test:')).toBe(true);
});

test('a different payload produces a different idempotency key', () => {
  const first = mailIdempotencyKey(renderMessage(welcomeMail, PAYLOAD, TO));
  const second = mailIdempotencyKey(renderMessage(welcomeMail, { ...PAYLOAD, name: 'Grace' }, TO));

  expect(first).not.toBe(second);
});

test('a different recipient produces a different idempotency key', () => {
  const first = mailIdempotencyKey(renderMessage(welcomeMail, PAYLOAD, TO));
  const second = mailIdempotencyKey(
    renderMessage(welcomeMail, PAYLOAD, { ...TO, to: 'grace@example.test' }),
  );

  expect(first).not.toBe(second);
});

test('recipient order and case do not change the key', () => {
  const first = mailIdempotencyKey(
    renderMessage(welcomeMail, PAYLOAD, { ...TO, to: ['ada@example.test', 'b@example.test'] }),
  );
  const second = mailIdempotencyKey(
    renderMessage(welcomeMail, PAYLOAD, { ...TO, to: ['B@example.test', 'Ada@example.test'] }),
  );

  expect(first).toBe(second);
});

test("the caller's idempotency key wins over the derived one", () => {
  const message = renderMessage(welcomeMail, PAYLOAD, { ...TO, idempotencyKey: 'signup:42' });
  // Scoped to the mail: a caller key is an id from the caller's domain, and two mails about one
  // signup sharing a key means the queue and the provider drop the second, silently.
  expect(mailIdempotencyKey(message)).toBe('mail:welcome:signup:42');
});

/**
 * The queued half of the header rule. `renderMessage` gates the inline path, but a queue row is not
 * necessarily one this process rendered and `mailMessageSchema` proves only the SHAPE of a payload
 * — `t.string` accepts a subject with a CR in it. Refused before a driver is even reached, so a
 * hand-written or replayed row cannot inject headers on the one transport that builds them.
 */
test('a queued payload with a line break in its subject never reaches a driver', async () => {
  resetMailDriver();
  const reached: string[] = [];
  setMailDriver({
    name: 'probe',
    send: (message) => {
      reached.push(message.subject);
      return Promise.reject(driverUnavailable('this probe never delivers'));
    },
  });

  const poisoned: MailMessage = {
    ...renderMessage(welcomeMail, PAYLOAD, TO),
    subject: 'Welcome\r\nBcc: evil@example.test',
  };
  // The body reads `input` and nothing else, so the rest of the run args are deliberately absent
  // rather than faked: a `Ctx` and a `StepApi` built here would assert nothing and could drift.
  const args = { input: poisoned } as JobRunArgs<MailMessage>;
  const failure = await sendMailJob.run(args).then(
    (): unknown => undefined,
    (error: unknown) => error,
  );

  expect(isUltimateError(failure) ? failure.code : failure).toBe('X_MAIL_HEADER_INVALID');
  expect(reached).toEqual([]);
  resetMailDriver();
});

test('the send job retries five times with exponential backoff', () => {
  expect(sendMailJob.retry.attempts).toBe(5);
  expect(sendMailJob.retry.backoff).toBe('exponential');
  expect(sendMailJob.name).toBe('mail.send');

  const message = renderMessage(welcomeMail, PAYLOAD, TO);
  expect(sendMailJob.idempotencyKeyFor(message)).toBe(mailIdempotencyKey(message));
});
