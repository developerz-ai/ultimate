// Tests for the Resend HTTPS transport: request shape, status-to-retryable mapping, and the
// fail-fast construction checks. Every test injects its own fetch — the sealed test network
// throws on any real request, so there is no path here that reaches the internet.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { MailMessage } from './driver';
import { createResendDriver, RESEND_BASE_URL } from './driver-resend';
import { mailIdempotencyKey } from './idempotency';

const API_KEY = 'resend_sk_test_do_not_leak_9f8e7d6c5b4a';
const FROM = 'Postly <no-reply@postly.test>';

function messageFixture(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    mailId: 'mail_welcome',
    to: ['ada@example.test'],
    subject: 'Welcome to Postly',
    html: '<p>Hello Ada</p>',
    text: 'Hello Ada',
    locale: 'en',
    tz: 'UTC',
    ...overrides,
  };
}

function codeOf(value: unknown): string {
  return isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;
}

function metaOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isUltimateError(value) ? value.meta : undefined;
}

function fixOf(value: unknown): string {
  return isUltimateError(value) ? value.fix : '';
}

function causeOf(value: unknown): string {
  return isUltimateError(value) ? value.cause : '';
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * Answers every request with `response` and records what it sent. Each call gets a `clone()`: a
 * body is single-use, so handing the same instance to a second send would have the driver read an
 * already-consumed body and fall back to a local id — passing the test for the wrong reason.
 */
function fetchStub(response: Response): { fetch: typeof globalThis.fetch; seen: Seen } {
  const seen: Seen = { url: '', method: '', headers: new Headers(), body: {} };
  const impl: typeof globalThis.fetch = async (input, init) => {
    seen.url = String(input);
    seen.method = init?.method ?? '';
    seen.headers = new Headers(init?.headers);
    seen.body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    return response.clone();
  };
  return { fetch: impl, seen };
}

function errorResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

test('happy path: posts to /emails with the right headers and body', async () => {
  const { fetch, seen } = fetchStub(Response.json({ id: 'em_9f8e7d6c5b4a' }));
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });
  const message = messageFixture({ cc: ['grace@example.test'], bcc: ['ops@example.test'] });

  const result = await driver.send(message);

  expect(seen.url).toBe(`${RESEND_BASE_URL}/emails`);
  expect(seen.method).toBe('POST');
  expect(seen.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
  expect(seen.headers.get('content-type')).toBe('application/json');
  expect(seen.body).toEqual({
    from: FROM,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: { 'Auto-Submitted': 'auto-generated' },
    cc: ['grace@example.test'],
    bcc: ['ops@example.test'],
  });
  expect(result).toEqual({
    id: 'em_9f8e7d6c5b4a',
    driver: 'resend',
    queued: false,
    accepted: ['ada@example.test', 'grace@example.test', 'ops@example.test'],
    idempotencyKey: mailIdempotencyKey(message),
  });
});

test("Idempotency-Key carries the caller's key when the message names one", async () => {
  const { fetch, seen } = fetchStub(Response.json({ id: 'em_idem_1' }));
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  await driver.send(messageFixture({ idempotencyKey: 'welcome-ada-2026' }));

  // Scoped to the mail: Resend drops a second message carrying a key it has already seen, so two
  // templates sharing the caller's key would mean one of them is never delivered.
  expect(seen.headers.get('idempotency-key')).toBe('mail:mail_welcome:welcome-ada-2026');
});

test('Idempotency-Key is content-derived when the message names none', async () => {
  const { fetch, seen } = fetchStub(Response.json({ id: 'em_idem_2' }));
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });
  const message = messageFixture();

  const first = await driver.send(message);
  // The job hands the same envelope to a retry, so the header must be identical across attempts
  // — that is the whole reason a retried send is not a second email.
  const second = await driver.send(message);

  expect(seen.headers.get('idempotency-key')).toBe(mailIdempotencyKey(message));
  expect(seen.headers.get('idempotency-key')).toStartWith('mail:mail_welcome:ada@example.test:');
  // Both attempts read the provider's id out of a live body: a stub that handed the same Response
  // to the second call would leave it consumed, and the id would silently become a local one.
  expect(first.id).toBe('em_idem_2');
  expect(second.id).toBe('em_idem_2');
});

test('includes cc, bcc and reply_to in the body only when the message sets them', async () => {
  const { fetch, seen } = fetchStub(Response.json({ id: 'em_cc_1' }));
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  await driver.send(
    messageFixture({
      cc: ['grace@example.test'],
      bcc: ['ops@example.test'],
      replyTo: 'support@example.test',
    }),
  );

  expect(seen.body['cc']).toEqual(['grace@example.test']);
  expect(seen.body['bcc']).toEqual(['ops@example.test']);
  expect(seen.body['reply_to']).toBe('support@example.test');
});

test('omits cc, bcc and reply_to keys entirely when unset — never sends them as null', async () => {
  const { fetch, seen } = fetchStub(Response.json({ id: 'em_cc_2' }));
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  await driver.send(messageFixture());

  expect(Object.hasOwn(seen.body, 'cc')).toBe(false);
  expect(Object.hasOwn(seen.body, 'bcc')).toBe(false);
  expect(Object.hasOwn(seen.body, 'reply_to')).toBe(false);
});

test('429 is retryable', async () => {
  const { fetch } = fetchStub(
    errorResponse(429, { message: 'Too many requests', name: 'rate_limit_exceeded' }),
  );
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  const error = await caught(driver.send(messageFixture()));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)?.['retryable']).toBe(true);
  expect(metaOf(error)?.['status']).toBe(429);
});

test('422 (unverified domain) is not retryable', async () => {
  const { fetch } = fetchStub(
    errorResponse(422, { message: 'Domain not verified', name: 'validation_error' }),
  );
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  const error = await caught(driver.send(messageFixture()));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)?.['retryable']).toBe(false);
  expect(metaOf(error)?.['status']).toBe(422);
});

test('500 is retryable', async () => {
  const { fetch } = fetchStub(errorResponse(500, { message: 'internal error' }));
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  const error = await caught(driver.send(messageFixture()));

  expect(metaOf(error)?.['retryable']).toBe(true);
  expect(metaOf(error)?.['status']).toBe(500);
});

test('401 is not retryable and the fix names RESEND_API_KEY', async () => {
  const { fetch } = fetchStub(
    errorResponse(401, { message: 'Invalid API key', name: 'authentication_error' }),
  );
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  const error = await caught(driver.send(messageFixture()));

  expect(metaOf(error)?.['retryable']).toBe(false);
  expect(fixOf(error)).toContain('RESEND_API_KEY');
});

test("the provider's message reaches the cause and the API key never leaks", async () => {
  const { fetch } = fetchStub(
    errorResponse(422, {
      message: 'Domain example.test is not verified',
      name: 'validation_error',
    }),
  );
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  const error = await caught(driver.send(messageFixture()));

  expect(causeOf(error)).toContain('Domain example.test is not verified');
  const rendered = isUltimateError(error)
    ? `${error.format()}\n${JSON.stringify(error.toJSON())}`
    : '';
  expect(rendered).not.toContain(API_KEY);
});

test('a fetch that rejects (DNS/TLS/reset) is retryable with no status', async () => {
  const failingFetch: typeof globalThis.fetch = async () => {
    throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.resend.com');
  };
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch: failingFetch });

  const error = await caught(driver.send(messageFixture()));

  expect(codeOf(error)).toBe('X_MAIL_SEND_FAILED');
  expect(metaOf(error)?.['retryable']).toBe(true);
  expect(metaOf(error)?.['status']).toBeUndefined();
});

test('a 2xx response with no readable id is still a success, using a local id', async () => {
  const { fetch } = fetchStub(Response.json({}));
  const driver = createResendDriver({ apiKey: API_KEY, from: FROM, fetch });

  const result = await driver.send(messageFixture());

  expect(result.driver).toBe('resend');
  expect(result.queued).toBe(false);
  expect(result.id.startsWith('resend_')).toBe(true);
});

test('an empty apiKey throws X_ENV_MISSING at construction', () => {
  const error = thrown(() => createResendDriver({ apiKey: '', from: FROM }));
  expect(codeOf(error)).toBe('X_ENV_MISSING');
});

test('a whitespace-only apiKey also throws X_ENV_MISSING at construction', () => {
  const error = thrown(() => createResendDriver({ apiKey: '   ', from: FROM }));
  expect(codeOf(error)).toBe('X_ENV_MISSING');
});

test('an empty from address throws X_CONFIG_INVALID at construction', () => {
  const error = thrown(() => createResendDriver({ apiKey: API_KEY, from: '' }));
  expect(codeOf(error)).toBe('X_CONFIG_INVALID');
});

test('a custom baseUrl is honoured', async () => {
  const { fetch, seen } = fetchStub(Response.json({ id: 'em_custom_base' }));
  const driver = createResendDriver({
    apiKey: API_KEY,
    from: FROM,
    baseUrl: 'https://relay.internal.test/resend',
    fetch,
  });

  await driver.send(messageFixture());

  expect(seen.url).toBe('https://relay.internal.test/resend/emails');
});
