// Single responsibility: refuse a `MailMessage` whose header-bound fields carry a CR or LF, before
// any transport sees it. The rule is a property of the MESSAGE and not of a wire format, so it is
// checked where a message is built rather than once per driver — it shipped only in `mime.ts`, so
// a subject an SMTP deploy rejected was accepted by memory in dev and by Resend in staging.

import { type MailMessage, messageHeaders } from './driver';
import { headerInvalid } from './errors';

/** A break ends the header early and everything after it becomes headers of the sender's choosing. */
const BREAK = /[\r\n]/;

/**
 * Every field of `message` that becomes a header, through the one function that decides which
 * headers a message gets — so a header added there is gated here without a second edit.
 *
 * `mime.ts` keeps its own per-header gate and is NOT redundant: it also covers `From`, `Date` and
 * `Message-ID`, which the transport mints and no message-level check can see, and it is the last
 * thing every present and future caller of `buildMimeMessage` passes through.
 */
export function assertHeaderSafe(message: MailMessage): void {
  if (BREAK.test(message.subject)) throw headerInvalid('Subject', message.mailId);
  // The ADDRESS LISTS, which went through no gate at all: `messageHeaders` emits `Auto-Submitted`,
  // `Reply-To` and the two `List-Unsubscribe` lines and nothing else, while `to` and `cc` become
  // `To:` and `Cc:` in `mime.ts`. A recipient carrying `\r\nBcc: attacker@evil.test` was accepted
  // by `renderMessage` and came back in `SendResult.accepted`; SMTP refuses it one layer down, the
  // memory driver and Resend do not — the exact split this rule was lifted out of `mime.ts` to
  // close.
  //
  // `bcc` is deliberately NOT here: it is an envelope field and never a header, so it is gated by
  // `envelope-address.ts` on the wire that carries it (`X_MAIL_ADDRESS_INVALID`) — two wire
  // formats, one gate each. Naming it here would report a `Bcc` header that no message has.
  for (const [header, addresses] of [
    ['To', message.to],
    ['Cc', message.cc],
  ] as const) {
    for (const address of addresses ?? []) {
      if (BREAK.test(address)) throw headerInvalid(header, message.mailId);
    }
  }
  for (const [name, value] of Object.entries(messageHeaders(message))) {
    if (BREAK.test(value)) throw headerInvalid(name, message.mailId);
  }
}
