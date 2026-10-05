// One delivery attempt on the wire: the headers it carries, the POST, what the answer means, and
// which of the three failure codes it becomes. Everything BEFORE the socket — the endpoint, the
// screen, the event, the gates — and everything AFTER it — the ledger, disable-after-N — is
// `webhook.ts`'s; this file only ever sees an approved target and a signed body.

import {
  // Core's ONE table, never a fifth copy of it. The copy that lived here omitted 409, so a
  // receiver saying "a concurrent writer won this round" dead-lettered on attempt 1 as a refusal
  // no retry could change — the exact divergence `retryable-status.ts` was extracted to end.
  isRetryableStatus,
  isUltimateError,
  renderThrowable,
  retryAfterSecondsOf,
  webhookHeaders,
} from '@ultimat3/core';
import { JobTimeoutError } from './errors';
import {
  WebhookDeliveryFailedError,
  WebhookDeliveryRejectedError,
  WebhookDeliveryThrottledError,
} from './webhook-errors';
import type { WebhookTarget } from './webhook-target';

/**
 * The transport — just the call: `typeof fetch` also carries `preconnect`, which no test double
 * should have to. `init.tls.serverName` carries the hostname a PINNED connection proves, because
 * the url it is handed names the approved address (`webhook-target.ts`); Bun's `fetch` honours it.
 */
export type WebhookFetch = (
  url: string,
  init: RequestInit & { readonly tls?: { readonly serverName?: string } },
) => Promise<Response>;

/** The one content type a delivery announces. The BODY is the app's; how it is framed is not. */
export const WEBHOOK_CONTENT_TYPE = 'application/json';

/** What of a `WebhookEndpoint` an attempt reads. Never the secret: that is inside `signing`. */
export interface DeliveryEndpoint {
  readonly id: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Outcome =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly detail: string;
      readonly retryAfterSeconds?: number;
    };

/**
 * The receiver's `Retry-After`, through core's one reader: delta-seconds as before, and now the
 * HTTP-date form too, measured against the SAME response's `Date` — the receiver's clock against
 * the receiver's clock, which is what made the date safe to read without trusting ours. Capped at
 * a day, and the nack clamps it to the policy's `maxDelay` on top.
 */
const retryAfterSeconds = (response: Response): number | undefined =>
  retryAfterSecondsOf(response.headers.get('retry-after'), response.headers.get('date'));

/**
 * The row's own headers, then the framework's — each SET, case-insensitively, over whatever the row
 * said. An object spread cannot do this: `{ Host: 'evil.test', host: <pinned> }` keeps both keys and
 * `fetch` joins them, so a row would reach another virtual host, change the content type, and ship
 * a forged value inside the signature list. Going through `Headers` collapses every spelling of a
 * name to one entry before the framework's value replaces it. Returned as a plain lowercase record,
 * because an injected `WebhookFetch` has always been handed one.
 *
 * Inside the caller's `try`: a row header the platform refuses (a newline in a value) is the same
 * failed attempt it always was, never a bare `TypeError` out of the job.
 */
function deliveryHeaders(
  endpoint: DeliveryEndpoint,
  target: WebhookTarget,
  signing: Parameters<typeof webhookHeaders>[0],
): Record<string, string> {
  const headers = new Headers(endpoint.headers);
  // The name the pinned address is reached AS, so an endpoint cannot redirect the request to a
  // different virtual host than the one it registered.
  headers.set('host', target.host);
  headers.set('content-type', WEBHOOK_CONTENT_TYPE);
  // The signature and the event identity it covers: a row can never overwrite what it is proved by.
  for (const [name, value] of Object.entries(webhookHeaders(signing))) headers.set(name, value);
  return Object.fromEntries(headers.entries());
}

/** The reason `JobDrainedError` carries — the one cancellation a request on the wire outlives. */
const DRAINING = 'X_DRAINING';

const isDrain = (reason: unknown): boolean => isUltimateError(reason) && reason.code === DRAINING;

/** The request's own signal, and the listener it hangs on the attempt's, handed back after. */
export interface DeliverySignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Where this attempt's own deadline falls, on `performance.now()`'s clock. */
export interface AttemptDeadline {
  readonly atMs: number;
  readonly job: string;
  readonly timeoutMs: number;
}

/**
 * The attempt's signal for every reason but the DRAIN. A deadline or a lost lease is followed by a
 * nack that hands the job to another worker at once, so a request still open is the receiver
 * getting the event twice: those tear it down. The drain is the opposite case — tearing a POST
 * already on the wire down hands the job to the next pod, which re-POSTs the same event on every
 * deploy — so the request finishes inside the drain budget instead, and its outcome is recorded.
 *
 * Not past the attempt's DEADLINE, though. The attempt's signal keeps its FIRST reason, so once the
 * drain has aborted it the deadline behind it never arrives there — while `executeJob` still hands
 * the job on when the deadline passes. So a drained request arms the deadline itself.
 */
export function deliverySignal(attempt: AbortSignal, deadline?: AttemptDeadline): DeliverySignal {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = (): void => {
    if (!isDrain(attempt.reason)) {
      request.abort(attempt.reason);
      return;
    }
    if (deadline === undefined) return;
    timer = setTimeout(
      () =>
        request.abort(new JobTimeoutError({ job: deadline.job, timeoutMs: deadline.timeoutMs })),
      Math.max(0, deadline.atMs - performance.now()),
    );
  };
  if (attempt.aborted) follow();
  else attempt.addEventListener('abort', follow, { once: true });
  return {
    signal: request.signal,
    dispose: () => {
      attempt.removeEventListener('abort', follow);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * One POST, on `deliverySignal`'s signal: torn down by the deadline or a lost lease, never by the
 * drain.
 */
export async function attemptDelivery(
  send: WebhookFetch,
  endpoint: DeliveryEndpoint,
  target: WebhookTarget,
  signing: Parameters<typeof webhookHeaders>[0],
  signal: AbortSignal,
): Promise<Outcome> {
  let response: Response;
  try {
    response = await send(target.url, {
      method: 'POST',
      headers: deliveryHeaders(endpoint, target, signing),
      ...(target.serverName === undefined ? {} : { tls: { serverName: target.serverName } }),
      body: signing.body,
      // Never followed: a 3xx would re-POST a body signed for one host to whatever the receiver
      // named, and the signature would travel with it.
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    // `renderThrowable`, never `String(error)` or `${error}`: this string lands in a `cause` and on
    // a durable ledger row, and a null-prototype throwable makes both of those a `TypeError`.
    return { ok: false, status: null, detail: renderThrowable(error) };
  }
  if (response.ok) return { ok: true, status: response.status };
  const stated = retryAfterSeconds(response);
  return {
    ok: false,
    status: response.status,
    detail: `status ${response.status}`,
    ...(stated === undefined ? {} : { retryAfterSeconds: stated }),
  };
}

/** Which of the three failure codes this outcome is. The split is "can the same request land?". */
export function deliveryError(
  name: string,
  endpoint: DeliveryEndpoint,
  outcome: Extract<Outcome, { ok: false }>,
): Error {
  const base = { webhook: name, endpointId: endpoint.id, url: endpoint.url };
  if (outcome.status === null) {
    return new WebhookDeliveryFailedError({ ...base, status: null, detail: outcome.detail });
  }
  if (!isRetryableStatus(outcome.status)) {
    return new WebhookDeliveryRejectedError({ ...base, status: outcome.status });
  }
  if (outcome.retryAfterSeconds !== undefined) {
    return new WebhookDeliveryThrottledError({
      ...base,
      status: outcome.status,
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  return new WebhookDeliveryFailedError({
    ...base,
    status: outcome.status,
    detail: outcome.detail,
  });
}
