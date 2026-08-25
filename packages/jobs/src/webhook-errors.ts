// The eight `X_WEBHOOK_*` codes an outbound delivery can end on, apart from `errors.ts` for the
// reason `backfill-errors.ts` is: one file, one job, and `errors.ts` holds the registry. The codes,
// the titles and the single `registerErrorCodes()` call stay there; only the classes live here.
//
// THE RULE THIS FILE EXISTS TO KEEP: no secret and no signature reaches a `cause`, a `fix` or a
// `meta`. A refusal is read by the caller, the log store and the dead-letter row, and a credential
// in any of the three is a leak wearing a diagnostic's clothes. The URL is redacted for the same
// reason one step down — several senders in the wild put a token in the query string, so only the
// origin and path travel.

import { UltimateError } from '@ultimat3/core';

/**
 * Origin + path, never the query and never any userinfo. A webhook URL is an operator's fact and
 * a `cause` must carry enough of it to act on, but `https://hooks.example/x?token=…` is a
 * credential in a field that reaches the log store unredactable.
 */
export function webhookTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Never `${error}` and never the URL itself: an unparseable value is exactly the one whose
    // shape is unknown, and this string is going into a durable row.
    return '<unparseable url>';
  }
}

/** The endpoint seam answered nothing. Terminal: a queued delivery cannot invent a destination. */
export class WebhookEndpointUnknownError extends UltimateError {
  constructor(input: { webhook: string; endpointId: string }) {
    super({
      code: 'X_WEBHOOK_ENDPOINT_UNKNOWN',
      cause: `webhook "${input.webhook}" has no endpoint ${input.endpointId}`,
      fix: `return the endpoint row for ${input.endpointId} from webhook("${input.webhook}").endpoint, or stop enqueueing deliveries for endpoints your app has deleted`,
      meta: { endpointId: input.endpointId },
    });
  }
}

/** The endpoint exists and cannot be delivered to as declared. */
export class WebhookEndpointInvalidError extends UltimateError {
  constructor(input: { webhook: string; endpointId: string; reason: string }) {
    super({
      code: 'X_WEBHOOK_ENDPOINT_INVALID',
      cause: `webhook "${input.webhook}" endpoint ${input.endpointId} ${input.reason}`,
      fix: `give the endpoint an https:// url and a non-empty secret before webhook("${input.webhook}").endpoint returns it — a delivery with neither is an unsigned POST to wherever the row points`,
      meta: { endpointId: input.endpointId },
    });
  }
}

/**
 * The endpoint takes nothing, either because the app disabled it or because this delivery is the
 * one that reached `disableAfter`. Terminal by construction: the next attempt reads the same row.
 */
export class WebhookEndpointDisabledError extends UltimateError {
  constructor(input: {
    webhook: string;
    endpointId: string;
    consecutiveFailures?: number;
    disableAfter?: number;
  }) {
    const why =
      input.consecutiveFailures === undefined
        ? 'is disabled'
        : `failed ${input.consecutiveFailures} deliveries in a row and disableAfter is ${String(input.disableAfter)}`;
    super({
      code: 'X_WEBHOOK_ENDPOINT_DISABLED',
      cause: `webhook "${input.webhook}" endpoint ${input.endpointId} ${why}`,
      fix: `fix the receiver, then re-enable the endpoint in your own table and enqueue the deliveries it missed — the framework never re-enables one on its own, because a dead endpoint that heals itself is a retry loop with no end`,
      meta: { endpointId: input.endpointId },
    });
  }
}

/** The event seam answered nothing for a queued id. */
export class WebhookEventUnknownError extends UltimateError {
  constructor(input: { webhook: string; eventId: string }) {
    super({
      code: 'X_WEBHOOK_EVENT_UNKNOWN',
      cause: `webhook "${input.webhook}" has no event ${input.eventId}`,
      fix: `write the event row before enqueueing its delivery — inside the same transaction, so webhook("${input.webhook}").event can never be asked for a row that is not committed yet`,
      meta: { eventId: input.eventId },
    });
  }
}

/**
 * The event's id or topic cannot be put in the canonical string without making it ambiguous. This
 * is refused BEFORE the mac is taken, because a mac over an ambiguous string is a valid signature
 * for a delivery the sender did not write.
 */
export class WebhookEventInvalidError extends UltimateError {
  constructor(input: { webhook: string; eventId: string; field: string; max: number }) {
    super({
      code: 'X_WEBHOOK_EVENT_INVALID',
      cause: `webhook "${input.webhook}" event ${input.eventId} has a ${input.field} that cannot be signed: 1-${input.max} characters, no ":" and no control characters`,
      fix: `change how your app mints a ${input.field} — one mac over "v1:<t>:<id>:<topic>:<body>" would authenticate two different id/topic splits, so the separator can never appear in either`,
      meta: { eventId: input.eventId, field: input.field },
    });
  }
}

/**
 * The delivery did not land and the same request, unchanged, might: a 5xx, a throttle that named
 * no delay, or a connection that never opened. Retryable — the job's own policy spends the
 * backoff, which is core's one curve.
 */
export class WebhookDeliveryFailedError extends UltimateError {
  constructor(input: {
    webhook: string;
    endpointId: string;
    url: string;
    status: number | null;
    detail: string;
  }) {
    const answer = input.status === null ? 'never answered' : `answered ${input.status}`;
    super({
      code: 'X_WEBHOOK_DELIVERY_FAILED',
      cause: `webhook "${input.webhook}" delivery to ${webhookTarget(input.url)} ${answer}: ${input.detail}`,
      fix: 'no edit here — the job retries on its declared backoff; watch the endpoint with x jobs ls --json and fix the receiver before it reaches disableAfter',
      meta: { endpointId: input.endpointId, status: input.status },
    });
  }
}

/**
 * The receiver said "later" AND said when. Its own code because the answer is different work: the
 * nack waits the delay the receiver named (`statedDelayMs` reads `meta.retryAfterSeconds`, clamped
 * by the policy's `maxDelay`) instead of spending a curve against a number it was already given.
 */
export class WebhookDeliveryThrottledError extends UltimateError {
  constructor(input: {
    webhook: string;
    endpointId: string;
    url: string;
    status: number;
    retryAfterSeconds: number;
  }) {
    super({
      code: 'X_WEBHOOK_DELIVERY_THROTTLED',
      cause: `webhook "${input.webhook}" delivery to ${webhookTarget(input.url)} answered ${input.status} and asked for ${input.retryAfterSeconds}s`,
      fix: 'no edit here — the next attempt waits the delay the receiver named; if this endpoint throttles constantly, raise its retry.maxDelay or fan out fewer events to it',
      meta: {
        endpointId: input.endpointId,
        status: input.status,
        // The one spelling `statedDelayMs` reads. Never a second key.
        retryAfterSeconds: input.retryAfterSeconds,
      },
    });
  }
}

/**
 * The receiver refused in a way a retry cannot change — a 4xx that is not a throttle, or a
 * redirect. Its own code rather than an instance flag on the one above: `classifyThrown` reads a
 * per-instance `terminal` on an unregistered code as UNCLASSIFIED, so the distinction has to be a
 * registered code or it does not exist.
 */
export class WebhookDeliveryRejectedError extends UltimateError {
  constructor(input: { webhook: string; endpointId: string; url: string; status: number }) {
    super({
      code: 'X_WEBHOOK_DELIVERY_REJECTED',
      cause: `webhook "${input.webhook}" delivery to ${webhookTarget(input.url)} answered ${input.status}, which no retry changes`,
      fix: 'x jobs show <jobId> --json   # meta.status is the answer; then correct the url or the secret on this endpoint row in your own table — a 401 or 403 is a secret the two sides disagree about, a 404 is a path that moved',
      meta: { endpointId: input.endpointId, status: input.status },
    });
  }
}
