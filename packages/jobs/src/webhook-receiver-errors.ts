// The two codes an inbound `webhookReceiver()` owns: a declaration that cannot be served, and a
// verified delivery the queue would not take. Classes only; `error-codes.ts` registers the codes.
// No body, no header and no secret ever reaches a cause: a refusal is read by the log store.

import { renderThrowable, UltimateError } from '@ultimat3/core';

/** Seconds a vendor is told to wait before redelivering after the queue refused. */
export const WEBHOOK_RECEIVER_RETRY_AFTER_SECONDS = 30;

/** Refused at declaration, while modules load: no request is ever answered with it. */
export class WebhookReceiverInvalidError extends UltimateError {
  constructor(input: { receiver: string; field: string; reason: string; fix: string }) {
    super({
      code: 'X_WEBHOOK_RECEIVER_INVALID',
      cause: `webhookReceiver("${input.receiver}") ${input.field} ${input.reason}`,
      fix: `webhookReceiver({ name: '${input.receiver}', ${input.fix}, … })`,
      meta: { receiver: input.receiver, field: input.field },
    });
  }
}

/** What `verify` may answer as an event id: 1-256 printable ASCII characters, no space. */
export const WEBHOOK_EVENT_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

/**
 * `verify` answered an id no job may be keyed by. A 4xx, never a 5xx: a vendor retries a 5xx
 * forever and the answer would never change. The id itself is never echoed, only its length: an
 * 8,000-character header is not a value to put in a log line or a response.
 */
export class WebhookEventIdInvalidError extends UltimateError {
  constructor(input: { receiver: string; length: number }) {
    super({
      code: 'X_WEBHOOK_EVENT_ID_INVALID',
      cause: `webhookReceiver("${input.receiver}") verify answered an eventId of ${input.length} characters that is not 1-256 printable ASCII characters`,
      fix: `webhookReceiver({ name: '${input.receiver}', verify: (inbound) => ({ eventId }) }) — read eventId out of the signed bytes (verifyBodyHmac(...).text), 1-256 printable ASCII characters`,
      meta: { receiver: input.receiver, length: input.length },
    });
  }
}

/**
 * The enqueue failed, so the delivery is NOT acknowledged: 503 with `Retry-After` through the error
 * map (`meta.retryAfterSeconds`), and the vendor redelivers. The inner failure goes through core's
 * total renderer — it is a caught `unknown`.
 */
export class WebhookReceiverUnavailableError extends UltimateError {
  constructor(input: { receiver: string; eventId: string; error: unknown }) {
    super({
      code: 'X_WEBHOOK_RECEIVER_UNAVAILABLE',
      cause: `webhookReceiver("${input.receiver}") verified event ${input.eventId} and could not queue it: ${renderThrowable(input.error)}`,
      fix: 'x doctor --json   # then check DATABASE_URL on the web role; the vendor redelivers once the queue answers',
      meta: {
        receiver: input.receiver,
        eventId: input.eventId,
        retryAfterSeconds: WEBHOOK_RECEIVER_RETRY_AFTER_SECONDS,
      },
    });
  }
}
