// The inbound half of the framework's webhook mechanism: prove a request was signed by the holder
// of a shared secret, recently, over the bytes it actually carries. It is a plain function and not
// a pipeline stage because a receiver is an ordinary `api/` route — the secret is per sender, and
// only the route knows which one applies.
//
// THE FORMAT IS `@ultimat3/core`'s (`webhook-signature.ts`) and is not re-declared here. That
// module is at the tier both halves can reach: `@ultimat3/jobs` (tier 3) signs a delivery and its
// boundary forbids this package, and this package (tier 2) may not reach tier 3. What stays here
// is the POLICY — what counts as fresh, how large a body may be, and which refusal a receiver
// answers with.

import type { Clock } from '@ultimat3/core';
import {
  isCanonicalWebhookField,
  parseWebhookSignatureHeader,
  readWithinLimit,
  systemClock,
  timingSafeEqual,
  WEBHOOK_FIELD_MAX,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOPIC_HEADER,
  webhookMac,
} from '@ultimat3/core';
import { bodyInvalid, webhookSignatureInvalid, webhookSignatureStale } from './errors';

/**
 * How far a delivery's timestamp may sit from this clock, either way. Five minutes is the window
 * every sender in the wild already assumes, and it is a REPLAY BOUND, not a latency allowance: a
 * captured request stops being usable after it, which is the only thing that keeps an intercepted
 * delivery from being replayable forever.
 */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 300_000;

/**
 * Restated rather than read from `HttpConfig.bodyLimitBytes` (same number, `config.ts`): this
 * function runs inside a route handler with a raw `Request` and no pipeline config in scope, and a
 * receiver that must hold a 4 MB payload says so here rather than by widening every route's cap.
 */
export const DEFAULT_WEBHOOK_BODY_LIMIT = 1_048_576;

export interface WebhookVerifyOptions {
  /** The shared secret for THIS sender. Never logged, never rendered into a refusal. */
  readonly secret: string;
  /** Defaults to `DEFAULT_WEBHOOK_TOLERANCE_MS`. */
  readonly toleranceMs?: number;
  /** Defaults to `DEFAULT_WEBHOOK_BODY_LIMIT`. Enforced while the body streams. */
  readonly maxBytes?: number;
  /** Defaults to `systemClock`. A window no test can freeze is a window no test pins. */
  readonly clock?: Clock;
}

export interface VerifiedWebhook {
  /**
   * The sender's id for this event, signed and therefore unforgeable. It is the DEDUPE key: a
   * delivery replayed inside the tolerance window verifies again by design, and this is what lets
   * a receiver notice. The seen-set is the app's table — the framework has nowhere to keep one.
   */
  readonly eventId: string;
  /** The sender's routing label. Carried and signed, never interpreted (axiom 8). */
  readonly topic: string;
  /**
   * The exact text the signature covers. Parse THIS, never `request.json()` — the body stream is
   * spent, and a re-serialisation would not be the bytes that were signed.
   */
  readonly body: string;
  readonly signedAtMs: number;
}

/**
 * Prove the request came from the holder of `secret`, inside the tolerance window, over the bytes
 * it carries — and answer what was signed.
 *
 * The order is deliberate: the mac is checked BEFORE the window, so `X_WEBHOOK_SIGNATURE_STALE`
 * means "authentic and old" and never "unreadable and old". An operator reading it goes to a clock
 * or a replay, which is what that code is for.
 */
export async function verifyWebhookSignature(
  request: Request,
  options: WebhookVerifyOptions,
): Promise<VerifiedWebhook> {
  const pathname = new URL(request.url).pathname;
  const signature = parseWebhookSignatureHeader(request.headers.get(WEBHOOK_SIGNATURE_HEADER));
  if (signature === undefined) {
    throw webhookSignatureInvalid(
      pathname,
      `no readable ${WEBHOOK_SIGNATURE_HEADER} on the request`,
    );
  }

  const eventId = request.headers.get(WEBHOOK_ID_HEADER) ?? '';
  const topic = request.headers.get(WEBHOOK_TOPIC_HEADER) ?? '';
  if (!isCanonicalWebhookField(eventId) || !isCanonicalWebhookField(topic)) {
    throw webhookSignatureInvalid(
      pathname,
      `${WEBHOOK_ID_HEADER} and ${WEBHOOK_TOPIC_HEADER} must each be 1-${WEBHOOK_FIELD_MAX} characters and carry no ":"`,
    );
  }

  const maxBytes = options.maxBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT;
  // Through core's counting reader, the same one `UltimateRequest.#read` uses: a sender that
  // announces no length must not be able to make this handler hold an unbounded payload before the
  // signature it was never going to pass is even computed.
  const read = await readWithinLimit(request.body, maxBytes);
  if ('over' in read) {
    throw bodyInvalid(pathname, [`body is at least ${read.over} bytes, limit is ${maxBytes}`]);
  }

  // The mac is core's, over the RAW bytes: an HMAC is over a byte stream, so hashing the prefix
  // and then the body is identical to hashing one string — and it never round-trips a body that is
  // not valid UTF-8 through a decoder before the mac is taken over it.
  const expected = webhookMac({
    secret: options.secret,
    timestampText: signature.timestampText,
    eventId,
    topic,
    body: read.bytes,
  });
  // `timingSafeEqual`, never `===`: this is a mac comparison, and where the two first differ is
  // exactly what a timing oracle needs to forge one byte at a time.
  if (!timingSafeEqual(expected, signature.mac)) {
    throw webhookSignatureInvalid(pathname, 'the signature does not match the body that arrived');
  }

  const signedAtMs = signature.timestampSeconds * 1_000;
  const toleranceMs = options.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  const skewMs = Math.abs((options.clock ?? systemClock).now().getTime() - signedAtMs);
  // Both directions: a sender whose clock runs ahead is the same replay window pointed the other
  // way, and accepting the future half doubles it.
  if (skewMs > toleranceMs) throw webhookSignatureStale(pathname, skewMs, toleranceMs);

  return { eventId, topic, body: new TextDecoder().decode(read.bytes), signedAtMs };
}
