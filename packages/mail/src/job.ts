// Single responsibility: delivering a rendered message is background work, never request work.
// A slow SMTP host must not hold a request open, and at-least-once delivery must not mean two
// welcome emails — so the send is a `job` with a content-derived idempotency key.

import { type JobHandle, job } from '@ultimat3/jobs';
import { type StandardSchemaV1, t } from '@ultimat3/schema';
import { type MailMessage, mailDriver, type SendResult } from './driver';

/** The queue payload is the already-rendered envelope: rendering happens once, at send time. */
export const mailMessageSchema: StandardSchemaV1<unknown, MailMessage> = t.object({
  mailId: t.string,
  to: t.array(t.email),
  subject: t.string,
  html: t.string,
  text: t.string,
  locale: t.locale,
  tz: t.timezone,
  replyTo: t.email.optional(),
  cc: t.array(t.email).optional(),
  bcc: t.array(t.email).optional(),
  unsubscribeUrl: t.url.optional(),
  idempotencyKey: t.string.optional(),
});

/**
 * `(mailId, recipients, hash(rendered payload))`, or the caller's key when supplied.
 * Content-derived on purpose: a retry of the same request produces the same key, while an
 * intentional resend with different content produces a different one.
 */
export function mailIdempotencyKey(message: MailMessage): string {
  const explicit = message.idempotencyKey;
  if (explicit !== undefined && explicit !== '') return `mail:${explicit}`;
  const recipients = [...message.to].map((address) => address.toLowerCase()).sort();
  const digest = fnv1a32(
    stableStringify({
      subject: message.subject,
      html: message.html,
      text: message.text,
      cc: message.cc ?? [],
      bcc: message.bcc ?? [],
      locale: message.locale,
      tz: message.tz,
      unsubscribeUrl: message.unsubscribeUrl ?? '',
    }),
  );
  return `mail:${message.mailId}:${recipients.join(',')}:${digest}`;
}

/**
 * Five attempts with exponential backoff: transient 4xx/greylisting clears in minutes, and a
 * hard bounce still lands in the dead-letter queue where `x jobs dead --json` can show it.
 */
export const sendMailJob: JobHandle<MailMessage> = job<MailMessage>({
  name: 'mail.send',
  input: mailMessageSchema,
  idempotencyKey: mailIdempotencyKey,
  retry: { attempts: 5, backoff: 'exponential' },
  run: ({ input }): Promise<SendResult> => mailDriver().send(input),
});

/** Key order is normalised so two structurally equal payloads hash identically. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

/** FNV-1a, 32-bit. Not a security hash — a short, dependency-free, stable content id. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
