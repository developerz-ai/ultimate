// Single responsibility: delivering a rendered message is background work, never request work.
// A slow SMTP host must not hold a request open, and at-least-once delivery must not mean two
// welcome emails — so the send is a `job` keyed by the content-derived idempotency key.

import { type JobHandle, job } from '@ultimat3/jobs';
import { type StandardSchemaV1, t } from '@ultimat3/schema';
import { type MailMessage, mailDriver, type SendResult } from './driver';
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
  run: ({ input }): Promise<SendResult> => mailDriver().send(input),
});
