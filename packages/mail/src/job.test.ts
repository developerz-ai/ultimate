import { expect, test } from 'bun:test';
import { registerMailCatalog } from './catalog';
import { mailIdempotencyKey, sendMailJob } from './job';
import { renderMessage, type SendOptions } from './mail';
import { welcomeMail } from './templates';

registerMailCatalog('en');

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
  expect(mailIdempotencyKey(message)).toBe('mail:signup:42');
});

test('the send job retries five times with exponential backoff', () => {
  expect(sendMailJob.retry.attempts).toBe(5);
  expect(sendMailJob.retry.backoff).toBe('exponential');
  expect(sendMailJob.name).toBe('mail.send');

  const message = renderMessage(welcomeMail, PAYLOAD, TO);
  expect(sendMailJob.idempotencyKeyFor(message)).toBe(mailIdempotencyKey(message));
});
