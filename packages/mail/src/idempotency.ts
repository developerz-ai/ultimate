// Single responsibility: the content-derived key that makes at-least-once delivery safe. It lives
// apart from `job.ts` because the transports need it too: a job retry after a timeout hands the
// same envelope to the provider again, and without this key on the wire that is a second email.

// Core's canonical form, never a private copy: it is the one injective serializer, and a second
// one is where two spellings of one payload would start hashing differently.
import { canonicalJson } from '@ultimat3/core';
import type { MailMessage } from './driver';

/**
 * `(mailId, hash(recipients + rendered payload))`, or `(mailId, the caller's key)` when one is
 * supplied. Content-derived on purpose: a retry of the same request produces the same key, while
 * an intentional resend with different content produces a different one.
 *
 * The mailId is in BOTH branches, and the explicit one needs it most: a caller's key is a natural
 * id from its own domain (`signup:42`, an order id), so the welcome mail and the verify-email mail
 * about one signup would otherwise mint the same key — and the queue dedupes it (`onConflict:
 * 'dedupe'`) and Resend dedupes it, so the second mail is never delivered and nothing reports it.
 * Scoping to the template keeps the caller's dedupe where the caller meant it: this send, retried.
 */
export function mailIdempotencyKey(message: MailMessage): string {
  const explicit = message.idempotencyKey;
  if (explicit !== undefined && explicit !== '') {
    // Sent as written when it is a header-safe ASCII token that fits; digested otherwise, because
    // a raw non-ASCII or over-long key is a `TypeError` out of `Headers` or a 400 from Resend.
    return `mail:${message.mailId}:${HEADER_SAFE.test(explicit) ? explicit : contentDigest(explicit)}`;
  }
  const recipients = [...message.to].map((address) => address.toLowerCase()).sort();
  // The RECIPIENTS are hashed with the payload, never spelled out in the key: fifty addresses made
  // a 2 kB `Idempotency-Key` Resend refuses (its limit is 256) — a dead letter — and one non-ASCII
  // address made `Headers` throw, which the job retried as egress until it gave up. Every field
  // that reaches the wire is hashed, `replyTo` included: two mails differing only there are two.
  const digest = contentDigest(
    canonicalJson({
      recipients,
      subject: message.subject,
      html: message.html,
      text: message.text,
      cc: message.cc ?? [],
      bcc: message.bcc ?? [],
      locale: message.locale,
      tz: message.tz,
      replyTo: message.replyTo ?? '',
      unsubscribeUrl: message.unsubscribeUrl ?? '',
      // Only when it changes the wire: every key minted before the option existed stays the same.
      ...(message.unsubscribeOneClick === false ? { unsubscribeOneClick: false } : {}),
    }),
  );
  return `mail:${message.mailId}:${digest}`;
}

/** Visible ASCII, bounded well under Resend's 256 so the `mail:<id>:` prefix still fits. */
const HEADER_SAFE = /^[\x21-\x7e]{1,200}$/;

/**
 * The `Message-ID` token for a message, stable across every attempt of the same send.
 *
 * SMTP has no idempotency protocol, so this header is the ONE identifier a receiving mailbox can
 * collapse a duplicate on — and an attempt that times out after `DATA` is retryable, so the job
 * retry hands the server the identical mail. A fresh random token per attempt made that second copy
 * a different message to everything downstream.
 *
 * A one-way digest of the key, never the key itself: the key holds the recipient list, bcc
 * included, and a `Message-ID` is visible to every recipient of the mail.
 */
export function mailMessageIdToken(message: MailMessage): string {
  return contentDigest(mailIdempotencyKey(message));
}

/** 128 bits of hex: no collision at any volume a mailer reaches, and short enough for a header. */
const DIGEST_HEX_CHARS = 32;

/**
 * SHA-256, truncated. Two properties matter and only a specified algorithm has both. Width: a
 * 32-bit digest reaches a 1% chance of collision at ~9,300 payloads for one mailId and recipient
 * set, and a collision here is an email the provider dedupes away — 128 bits does not get there.
 * Stability: SHA-256's output is fixed by its specification, so a key minted by one Bun version
 * still matches the one minted by the next — `Bun.hash`'s families promise no such thing.
 */
function contentDigest(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex').slice(0, DIGEST_HEX_CHARS);
}
