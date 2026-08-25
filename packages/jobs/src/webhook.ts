// `webhook()` — one outbound delivery to one endpoint, declared as a `job` and NOT as a ninth
// primitive. A delivery is durable background work with an input schema, a retry policy, an
// idempotency key and a queue, which is the definition of a `job` — so this file is a FACTORY over
// `job()`, exactly as `backfill()` and `purge()` are and as `llm()` is over `action()`. That gives
// it `.enqueue()`, the retry backoff, the worker's cancellation, the dead-letter path,
// `x jobs show` and a manifest row without a line here.
//
// ONE ENDPOINT PER JOB, deliberately. Retry, backoff and disable-after-N are all per-endpoint
// facts, and a job that fanned out inside one body would retry every endpoint because one of them
// was down — the same defect `docs/architecture/15-adding-a-feature.md` names for a mail loop
// under a single step. WHICH endpoints exist is the app's (axiom 8), so the fan-out is the app's
// `for` loop over its own subscription table, one `enqueue` per endpoint.
//
// WHAT THIS MECHANISM OWNS: signing, a timestamped signature, retry with core's backoff,
// disable-after-N-consecutive-failures, and a ledger row per attempt. WHAT IT NEVER OWNS: the
// event taxonomy, which endpoints exist, and what a payload means.

import type { Clock, Ctx } from '@ultimat3/core';
import {
  isCanonicalWebhookField,
  renderThrowable,
  systemClock,
  WEBHOOK_FIELD_MAX,
  webhookHeaders,
} from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import { nowMs } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';
import {
  WebhookDeliveryFailedError,
  WebhookDeliveryRejectedError,
  WebhookDeliveryThrottledError,
  WebhookEndpointDisabledError,
  WebhookEndpointInvalidError,
  WebhookEndpointUnknownError,
  WebhookEventInvalidError,
  WebhookEventUnknownError,
} from './webhook-errors';
import type { WebhookLedger } from './webhook-ledger';

/** Just the call. `typeof fetch` also carries `preconnect`, which no test double should have to. */
export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Consecutive failures before an endpoint stops taking deliveries. Ten is roughly a day of a
 * retrying queue against a dead receiver, which is long enough for an outage and short enough that
 * a decommissioned endpoint does not cost the fleet forever.
 */
export const DEFAULT_WEBHOOK_DISABLE_AFTER = 10;

/** The one content type a delivery announces. The BODY is the app's; how it is framed is not. */
export const WEBHOOK_CONTENT_TYPE = 'application/json';

/** `Retry-After` in seconds. The HTTP-date form is ignored on purpose — see `retryAfterSeconds`. */
const RETRY_AFTER_SECONDS = /^\d{1,7}$/;

export interface WebhookEndpoint {
  readonly id: string;
  /** `https://…` in production, `http://…` for a dev receiver. Nothing else is opened. */
  readonly url: string;
  /** The shared secret. Never logged, never in a `cause`, never on the ledger row. */
  readonly secret: string;
  /** True stops every delivery before the socket opens. Set by the app, or by `disableAfter`. */
  readonly disabled?: boolean;
  /**
   * Extra headers this receiver asked for. Merged UNDER the framework's, so nothing here can
   * overwrite the signature, the id or the topic — an endpoint row that could set its own
   * `x-ultimate-webhook-signature` is an endpoint row that can forge one.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface WebhookEvent {
  /**
   * The sender's routing label, signed and carried and never interpreted. Which topics exist is
   * the app's taxonomy (axiom 8); that a delivery HAS one is the mechanism.
   */
  readonly topic: string;
  /**
   * The exact text to sign and send. Serialised by the app, because what a payload means is the
   * app's — and byte-stable within one attempt, which is all the signature needs.
   */
  readonly body: string;
}

/**
 * The queue row's payload: a POINTER, never a record. The event's bytes live in the app's own
 * table and are read once per attempt, so nothing durable here holds a payload and nothing here
 * holds a secret.
 */
export interface WebhookDeliveryInput {
  readonly endpointId: string;
  /** Also the id the receiver dedupes on — it is signed, so it cannot be moved in transit. */
  readonly eventId: string;
}

/** What one landed delivery reports. Bounded, so `x jobs show` can print it. */
export interface WebhookReport {
  readonly endpointId: string;
  readonly eventId: string;
  readonly status: number;
  readonly durationMs: number;
}

export interface WebhookDefinition {
  /**
   * REQUIRED, unlike a job's. A delivery's name is a durable queue key — every queued, retrying
   * and dead-lettered row carries it — so it is never left to whichever export name a module used.
   */
  readonly name: string;
  /**
   * REQUIRED, exactly as on `job()`: `tenant: ({ endpointId }) => …` for a delivery scoped to the
   * org that owns the endpoint, or the explicit `tenant: 'none'`. A delivery reads the app's own
   * endpoint and event rows through the seams below, so the org those reads run under is a fact
   * about the WORK and is declared here rather than inherited from whichever worker claimed it.
   */
  readonly tenant: JobTenant<WebhookDeliveryInput>;
  /**
   * The endpoint this delivery is for. Read once PER ATTEMPT and never checkpointed: it carries a
   * secret, and a `step.run` output is written to `x_job_steps` — a credential in a durable table
   * the queue keeps for the life of the run.
   */
  endpoint(args: {
    readonly endpointId: string;
    readonly ctx: Ctx;
  }): Promise<WebhookEndpoint | null> | WebhookEndpoint | null;
  /** The event's bytes. Read per attempt as well, out of the app's own table. */
  event(args: {
    readonly eventId: string;
    readonly ctx: Ctx;
  }): Promise<WebhookEvent | null> | WebhookEvent | null;
  /** Where every attempt is recorded, and where the consecutive-failure count comes from. */
  readonly ledger: WebhookLedger;
  /**
   * Consecutive failures before the endpoint is disabled. Defaults to
   * `DEFAULT_WEBHOOK_DISABLE_AFTER`. Re-enabling is always the app's — an endpoint the framework
   * un-disabled on its own is a retry loop with no end.
   */
  readonly disableAfter?: number;
  /** The clock the signature's timestamp and the ledger's instants are read from. */
  readonly clock?: Clock;
  /** Injected so a test can drive the transport. The network is sealed in this repo's suites. */
  readonly fetch?: WebhookFetch;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /**
   * The ceiling for ONE attempt, and therefore for the request inside it. Deliberately not a
   * second per-request timeout: `ctx.signal` already carries this deadline into `fetch`, and two
   * numbers for one wait is the ambiguity axiom 1 refuses.
   */
  readonly timeout?: DurationInput;
}

/** `Retry-After: 120`. The HTTP-date form needs the receiver's clock, which is what we do not trust. */
const retryAfterSeconds = (response: Response): number | undefined => {
  const header = response.headers.get('retry-after');
  if (header === null || !RETRY_AFTER_SECONDS.test(header.trim())) return undefined;
  return Number(header.trim());
};

/** A status the same request, unchanged, can still land on. Everything else is somebody's edit. */
const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 425 || status === 429;

export function webhook(definition: WebhookDefinition): JobHandle<WebhookDeliveryInput> {
  const clock = definition.clock ?? systemClock;
  const disableAfter = definition.disableAfter ?? DEFAULT_WEBHOOK_DISABLE_AFTER;
  const send = definition.fetch ?? ((url, init) => fetch(url, init));

  return job<WebhookDeliveryInput>({
    name: definition.name,
    input: t.object({ endpointId: t.string, eventId: t.string }),
    // Endpoint AND event: the same event fans out to every subscribed endpoint, so a key on the
    // event alone would dedupe every one of those deliveries into the first endpoint's row.
    idempotencyKey: ({ endpointId, eventId }) => `${definition.name}:${endpointId}:${eventId}`,
    tenant: definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    async run({ input, ctx, attempt }): Promise<WebhookReport> {
      const endpoint = await definition.endpoint({ endpointId: input.endpointId, ctx });
      if (endpoint === null) {
        throw new WebhookEndpointUnknownError({
          webhook: definition.name,
          endpointId: input.endpointId,
        });
      }
      // Before the ledger and before the socket: a disabled endpoint costs nothing, which is the
      // whole point of disabling one.
      if (endpoint.disabled === true) {
        throw new WebhookEndpointDisabledError({
          webhook: definition.name,
          endpointId: endpoint.id,
        });
      }
      assertDeliverable(definition.name, endpoint);

      const event = await definition.event({ eventId: input.eventId, ctx });
      if (event === null) {
        throw new WebhookEventUnknownError({ webhook: definition.name, eventId: input.eventId });
      }
      // Refused BEFORE the mac is taken. A mac over an ambiguous canonical string is a valid
      // signature for a delivery the sender never wrote — see `isCanonicalWebhookField`.
      for (const [field, value] of [
        ['event id', input.eventId],
        ['topic', event.topic],
      ] as const) {
        if (isCanonicalWebhookField(value)) continue;
        throw new WebhookEventInvalidError({
          webhook: definition.name,
          eventId: input.eventId,
          field,
          max: WEBHOOK_FIELD_MAX,
        });
      }

      // Seconds, at SEND time and not at event time: a delivery retried three days later is signed
      // again now, so a receiver's freshness window measures the request in front of it rather
      // than the age of the fact behind it.
      const timestampSeconds = Math.floor(nowMs(clock) / 1_000);
      const startedAt = clock.monotonic();
      const outcome = await attemptDelivery(send, endpoint, {
        secret: endpoint.secret,
        timestampSeconds,
        eventId: input.eventId,
        topic: event.topic,
        body: event.body,
      });
      const durationMs = Math.max(0, clock.monotonic() - startedAt);

      // Recorded whatever happened, and BEFORE the throw: a failure that is not on the ledger is a
      // failure the consecutive count cannot see, which is an endpoint that never gets disabled.
      const failures = await definition.ledger.record({
        webhook: definition.name,
        endpointId: endpoint.id,
        eventId: input.eventId,
        topic: event.topic,
        attempt,
        ok: outcome.ok,
        status: outcome.status,
        at: nowMs(clock),
        durationMs,
        ...(outcome.ok ? {} : { error: outcome.detail }),
      });

      if (outcome.ok) {
        return {
          endpointId: endpoint.id,
          eventId: input.eventId,
          status: outcome.status,
          durationMs,
        };
      }

      if (failures >= disableAfter) {
        const reason = `${failures} consecutive failed deliveries, disableAfter is ${disableAfter}`;
        await definition.ledger.disable(endpoint.id, reason);
        // The endpoint's own code and not this attempt's: what an operator needs to see is that
        // deliveries have STOPPED, not the status of the one that tipped it over.
        throw new WebhookEndpointDisabledError({
          webhook: definition.name,
          endpointId: endpoint.id,
          consecutiveFailures: failures,
          disableAfter,
        });
      }
      throw deliveryError(definition.name, endpoint, outcome);
    },
  });
}

/** A URL no delivery may open, or a secret that would make the POST unsigned. */
function assertDeliverable(name: string, endpoint: WebhookEndpoint): void {
  if (endpoint.secret.length === 0) {
    throw new WebhookEndpointInvalidError({
      webhook: name,
      endpointId: endpoint.id,
      reason: 'has an empty secret, so the delivery would carry no proof of who sent it',
    });
  }
  let protocol: string;
  try {
    protocol = new URL(endpoint.url).protocol;
  } catch {
    // Never the caught value and never the url: an unparseable value is exactly the one whose
    // shape is unknown, and this reason reaches a durable dead-letter row.
    throw new WebhookEndpointInvalidError({
      webhook: name,
      endpointId: endpoint.id,
      reason: 'has a url that is not a url',
    });
  }
  // `file:`, `data:` and the rest are refused by NAME rather than by a blocklist: a delivery opens
  // an HTTP conversation, and anything else is a row in a table reaching the worker's filesystem.
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new WebhookEndpointInvalidError({
      webhook: name,
      endpointId: endpoint.id,
      reason: `has a ${protocol} url, and a delivery only ever opens http: or https:`,
    });
  }
}

type Outcome =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly detail: string;
      readonly retryAfterSeconds?: number;
    };

async function attemptDelivery(
  send: WebhookFetch,
  endpoint: WebhookEndpoint,
  signing: Parameters<typeof webhookHeaders>[0],
): Promise<Outcome> {
  let response: Response;
  try {
    response = await send(endpoint.url, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        'content-type': WEBHOOK_CONTENT_TYPE,
        // LAST, so an endpoint row's own headers can never overwrite the signature it is proved by.
        ...webhookHeaders(signing),
      },
      body: signing.body,
      // Never followed: a 3xx would re-POST a body signed for one host to whatever the receiver
      // named, and the signature would travel with it.
      redirect: 'manual',
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
function deliveryError(
  name: string,
  endpoint: WebhookEndpoint,
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
