// Tests for the content-derived idempotency key: every field that reaches the wire changes it,
// nothing else does, and the exact digest is pinned — a provider that has already seen a key drops
// the message, so a quiet change to how it is derived is a duplicate email or a swallowed one.

import { expect, test } from 'bun:test';
import type { MailMessage } from './driver';
import { mailIdempotencyKey } from './idempotency';

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
  expect(mailIdempotencyKey(messageFixture())).toBe(
    'mail:welcome:ada@example.test:58f51a4f9562b916c9a91a4452d2162a',
  );
});

test('the digest is 128 bits of lowercase hex, so the header stays short and collision-free', () => {
  const digest = mailIdempotencyKey(messageFixture()).split(':')[3] ?? '';

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

test('the same message hashed twice gives the same key, and a caller key wins outright', () => {
  expect(mailIdempotencyKey(messageFixture())).toBe(mailIdempotencyKey(messageFixture()));
  expect(mailIdempotencyKey(messageFixture({ idempotencyKey: 'signup:42' }))).toBe(
    'mail:signup:42',
  );
});
