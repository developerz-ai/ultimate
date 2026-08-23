// The message-level CR/LF gate, over EVERY field that becomes a header — including the two that
// went through no gate at all until now.
//
// `to` and `cc` become `To:` and `Cc:` (`mime.ts`), and `assertHeaderSafe` checked `subject` plus
// `messageHeaders()`, which emits only `Auto-Submitted`, `Reply-To` and the two `List-Unsubscribe`
// lines. So a recipient carrying `\r\nBcc: attacker@evil.test` was ACCEPTED by `renderMessage`
// and came back in `SendResult.accepted`. SMTP refuses it one layer down (`envelope-address.ts`);
// the memory driver and Resend do not — which is the same split this file's own header says the
// rule was lifted out of `mime.ts` to close.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import type { MailMessage } from './driver';
import { assertHeaderSafe } from './header-safety';

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  mailId: 'welcome',
  to: ['ada@example.test'],
  subject: 'Welcome',
  html: '<p>hi</p>',
  text: 'hi',
  locale: 'en',
  tz: 'UTC',
  ...over,
});

const caught = (fn: () => unknown): UltimateError => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!isUltimateError(thrown)) expect.unreachable('expected assertHeaderSafe to throw');
  return thrown;
};

/** A CR, an LF and a CRLF: the header ends at the first of them, whichever it is. */
const BREAKS = ['\r', '\n', '\r\n'] as const;

describe('an address list is header-bound too', () => {
  // Spread: `test.each` takes a mutable `unknown[]`, and `as const` is what keeps the three cases
  // literal rather than widening them to `string` at the declaration.
  test.each([...BREAKS])('a recipient carrying %j is refused', (brk) => {
    const error = caught(() =>
      assertHeaderSafe(message({ to: [`victim@x.test${brk}Bcc: attacker@evil.test`] })),
    );
    expect(error.code).toBe('X_MAIL_HEADER_INVALID');
    expect(error.cause).toContain('To');
  });

  test('a break in ANY recipient is refused, not only the first', () => {
    expect(
      caught(() =>
        assertHeaderSafe(message({ to: ['ada@x.test', 'b@x.test\r\nBcc: e@evil.test'] })),
      ).code,
    ).toBe('X_MAIL_HEADER_INVALID');
  });

  test('a cc carrying a break is refused, and names Cc', () => {
    const error = caught(() =>
      assertHeaderSafe(message({ cc: ['ops@x.test\r\nBcc: attacker@evil.test'] })),
    );
    expect(error.code).toBe('X_MAIL_HEADER_INVALID');
    expect(error.cause).toContain('Cc');
  });

  test("bcc is NOT this gate's business — it is an envelope field, gated on its own wire", () => {
    // `packages/mail/CLAUDE.md`: "Bcc is an envelope field. It reaches RCPT TO and Resend's body,
    // never a header." `envelope-address.ts` refuses the same break with X_MAIL_ADDRESS_INVALID,
    // which is the code whose `fix:` names the right file. Two wire formats, one gate each.
    expect(() => assertHeaderSafe(message({ bcc: ['ops@x.test\nX-Injected: 1'] }))).not.toThrow();
  });

  test('the fields already gated stay gated', () => {
    expect(
      caught(() => assertHeaderSafe(message({ subject: 'Hi\r\nBcc: e@evil.test' }))).code,
    ).toBe('X_MAIL_HEADER_INVALID');
    expect(
      caught(() => assertHeaderSafe(message({ replyTo: 'a@x.test\r\nX-Injected: 1' }))).code,
    ).toBe('X_MAIL_HEADER_INVALID');
  });

  test('an ordinary message with several recipients passes', () => {
    expect(() =>
      assertHeaderSafe(
        message({ to: ['ada@x.test', 'grace@x.test'], cc: ['ops@x.test'], bcc: ['log@x.test'] }),
      ),
    ).not.toThrow();
  });
});
