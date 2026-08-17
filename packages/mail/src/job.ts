// Single responsibility: delivering a rendered message is background work, never request work.
// A slow SMTP host must not hold a request open, and at-least-once delivery must not mean two
// welcome emails — so the send is a `job` keyed by the content-derived idempotency key.

import { type JobHandle, job } from '@ultimat3/jobs';
import { type StandardSchemaV1, t } from '@ultimat3/schema';
import { type MailMessage, mailDriver, type SendResult } from './driver';
import { assertHeaderSafe } from './header-safety';
import { mailIdempotencyKey } from './idempotency';

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
 * Five attempts with exponential backoff: transient 4xx/greylisting clears in minutes, and a
 * hard bounce still lands in the dead-letter queue where `x jobs dead --json` can show it.
 */
export const sendMailJob: JobHandle<MailMessage> = job<MailMessage>({
  name: 'mail.send',
  input: mailMessageSchema,
  idempotencyKey: mailIdempotencyKey,
  // A send carries a MailMessage — addresses and a rendered body, never an org. The recipient
  // was resolved by whoever enqueued it, under their own tenant, so this run touches no
  // tenant-scoped table and has no org to declare.
  tenant: 'none',
  retry: { attempts: 5, backoff: 'exponential' },
  // `async`, so the refusal below is a REJECTED promise: a synchronous throw from a body whose
  // signature promises one escapes every caller that only awaits it.
  run: async ({ input }): Promise<SendResult> => {
    // The second boundary the header rule is checked at, and the one `renderMessage` cannot cover:
    // a queue row is not necessarily one this process rendered — `mailMessageSchema` proves the
    // SHAPE of a payload and says nothing about a break inside a string it accepted.
    assertHeaderSafe(input);
    return await mailDriver().send(input);
  },
});
