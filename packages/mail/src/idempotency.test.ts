// Tests for the content-derived idempotency key: every field that reaches the wire changes it,
// nothing else does, and the exact digest is pinned — a provider that has already seen a key drops
// the message, so a quiet change to how it is derived is a duplicate email or a swallowed one.

import { expect, test } from 'bun:test';
import type { MailMessage } from './driver';
import { mailIdempotencyKey } from './idempotency';

const PINNED = 'mail:welcome:3fc95ae4fcefe4ec3932c75f78be3e20';

function messageFixture(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    mailId: 'welcome',
    to: ['ada@example.test'],
    subject: 'Welcome to Postly',
    html: '<p>Hello Ada</p>',
    text: 'Hello Ada',
    locale: 'en',
    tz: 'Europe/Berlin',
    ...overrides,
  };
}

test('the key for a fixed message is pinned, so a change of digest cannot pass unnoticed', () => {
  // Not a tautology: this value was written down once. Changing the hash, the field list or the
  // key layout breaks it, which is the point — a deployed key that stops matching the previous
  // release's key for the same email is a duplicate send on every retry across the rollout.
  // Re-pinned 2026-09-23: the recipients moved INTO the digest (see below), a one-time key change.
  expect(mailIdempotencyKey(messageFixture())).toMatch(/^mail:welcome:[0-9a-f]{32}$/);
  expect(mailIdempotencyKey(messageFixture())).toBe(PINNED);
});

// The recipients were spelled out in the key: 50 recipients was a 2 kB header Resend refuses with
// a 400 (its limit is 256) — a dead letter — and one non-ASCII address made `Headers` throw a
// TypeError, which the job retried as egress until it gave up.
test('a 50-recipient send has a key of 256 characters or fewer, all ASCII', () => {
  const to = Array.from(
    { length: 50 },
    (_, index) => `recipient-${index}@a-long-domain.example.test`,
  );
  const key = mailIdempotencyKey(messageFixture({ to }));
  expect(key.length).toBeLessThanOrEqual(256);
  expect(key).toMatch(/^[\x21-\x7e]+$/);
  expect(() => new Headers({ 'Idempotency-Key': key })).not.toThrow();
});

test('a non-ASCII recipient still yields a header-safe key', () => {
  const key = mailIdempotencyKey(messageFixture({ to: ['zoë@例え.test'] }));
  expect(() => new Headers({ 'Idempotency-Key': key })).not.toThrow();
});

test('recipients still change the key, in any order and any case', () => {
  const one = mailIdempotencyKey(messageFixture({ to: ['a@x.test', 'B@x.test'] }));
  expect(mailIdempotencyKey(messageFixture({ to: ['b@x.test', 'a@x.test'] }))).toBe(one);
  expect(mailIdempotencyKey(messageFixture({ to: ['a@x.test'] }))).not.toBe(one);
});

test("a caller's key that is not header-safe is digested, never sent raw", () => {
  const key = mailIdempotencyKey(messageFixture({ idempotencyKey: `signup-ü-${'x'.repeat(400)}` }));
  expect(key.length).toBeLessThanOrEqual(256);
  expect(() => new Headers({ 'Idempotency-Key': key })).not.toThrow();
  expect(mailIdempotencyKey(messageFixture({ idempotencyKey: 'signup:42' }))).toBe(
    'mail:welcome:signup:42',
  );
});

test('the digest is 128 bits of lowercase hex, so the header stays short and collision-free', () => {
  const digest = mailIdempotencyKey(messageFixture()).split(':')[2] ?? '';

  expect(digest).toHaveLength(32);
  expect(digest).toMatch(/^[0-9a-f]{32}$/);
});

test('two messages differing only in replyTo get different keys', () => {
  // `replyTo` reaches the wire as `Reply-To` and as Resend's `reply_to`, so these are two
  // different emails; one shared key would have the provider drop the second as a duplicate.
  const bare = mailIdempotencyKey(messageFixture());
  const support = mailIdempotencyKey(messageFixture({ replyTo: 'support@postly.test' }));
  const billing = mailIdempotencyKey(messageFixture({ replyTo: 'billing@postly.test' }));

  expect(support).not.toBe(bare);
  expect(billing).not.toBe(support);
});

test('an absent replyTo and an empty one are the same message', () => {
  expect(mailIdempotencyKey(messageFixture({ replyTo: '' }))).toBe(
    mailIdempotencyKey(messageFixture()),
  );
});

test('every other field that reaches the wire changes the key', () => {
  const base = mailIdempotencyKey(messageFixture());
  const variants: Partial<MailMessage>[] = [
    { subject: 'Welcome to Postly!' },
    { html: '<p>Hello Grace</p>' },
    { text: 'Hello Grace' },
    { cc: ['grace@example.test'] },
    { bcc: ['ops@example.test'] },
    { locale: 'de' },
    { tz: 'UTC' },
    { unsubscribeUrl: 'https://postly.test/u/abc' },
    { mailId: 'invite' },
    { to: ['grace@example.test'] },
  ];

  for (const overrides of variants) {
    expect(mailIdempotencyKey(messageFixture(overrides))).not.toBe(base);
  }
});

test('the same message hashed twice gives the same key, and a caller key wins over the digest', () => {
  expect(mailIdempotencyKey(messageFixture())).toBe(mailIdempotencyKey(messageFixture()));
  expect(mailIdempotencyKey(messageFixture({ idempotencyKey: 'signup:42' }))).toBe(
    'mail:welcome:signup:42',
  );
});

test('a caller key is scoped to its mail, so two templates cannot dedupe each other away', () => {
  // A caller's key is an id from its own domain — one signup, one order — so the same value
  // reaches every mail about that thing. Sharing a key means the queue (`onConflict: 'dedupe'`)
  // and Resend both drop the second mail, and neither of them reports having done it.
  const welcome = mailIdempotencyKey(messageFixture({ idempotencyKey: 'signup:42' }));
  const verify = mailIdempotencyKey(
    messageFixture({ mailId: 'verify-email', idempotencyKey: 'signup:42' }),
  );

  expect(welcome).not.toBe(verify);
});
