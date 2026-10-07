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
  assert,
  finiteOption,
  isCanonicalWebhookField,
  isUltimateError,
  systemClock,
  throwIfAborted,
  WEBHOOK_FIELD_MAX,
} from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import { nowMs } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';
import type { Outcome, WebhookFetch } from './webhook-attempt';
import { attemptDelivery, deliveryError, deliverySignal } from './webhook-attempt';
import {
  WebhookEndpointDisabledError,
  WebhookEndpointInvalidError,
  WebhookEndpointUnknownError,
  WebhookEventInvalidError,
  WebhookEventUnknownError,
} from './webhook-errors';
import type { WebhookLedger } from './webhook-ledger';
import type { WebhookResolve } from './webhook-target';
import { resolveWebhookHost, webhookTarget } from './webhook-target';

/**
 * Consecutive failures before an endpoint stops taking deliveries. Ten is roughly a day of a
 * retrying queue against a dead receiver, which is long enough for an outage and short enough that
 * a decommissioned endpoint does not cost the fleet forever.
 */
export const DEFAULT_WEBHOOK_DISABLE_AFTER = 10;

export interface WebhookEndpoint {
  readonly id: string;
  /**
   * `https://…` in production, `http://…` only in a local environment. A host that resolves to a
   * loopback, private, link-local, ULA, CGNAT or unspecified address is refused unless the
   * definition sets `allowPrivate` (`webhook-target.ts`). Nothing else is opened.
   */
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
  /**
   * The org that owns the endpoint, for a delivery declared `tenant: ({ orgId }) => orgId`. On the
   * input because `tenant` is a synchronous function of the input alone — derived from the
   * endpoint id it would be a read before the run has an org to read under. Neither signed nor
   * sent: the receiver learns nothing it did not already know.
   */
  readonly orgId?: string | undefined;
}

/** A delivery to an endpoint an org owns: the org is REQUIRED at the enqueue. */
export interface OrgWebhookDeliveryInput extends WebhookDeliveryInput {
  readonly orgId: string;
}

/** What one landed delivery reports. Bounded, so `x jobs show` can print it. */
export interface WebhookReport {
  readonly endpointId: string;
  readonly eventId: string;
  readonly status: number;
  readonly durationMs: number;
}

export interface WebhookDefinition<I extends WebhookDeliveryInput = WebhookDeliveryInput> {
  /**
   * REQUIRED, unlike a job's. A delivery's name is a durable queue key — every queued, retrying
   * and dead-lettered row carries it — so it is never left to whichever export name a module used.
   */
  readonly name: string;
  /**
   * REQUIRED, exactly as on `job()`: `tenant: ({ orgId }) => orgId` for a delivery scoped to the
   * org that owns the endpoint — every enqueue then carries `orgId` (`OrgWebhookDeliveryInput`) —
   * or the explicit `tenant: 'none'`. A delivery reads the app's own endpoint and event rows
   * through the seams below, so the org those reads run under is a fact about the WORK and is
   * declared here rather than inherited from whichever worker claimed it.
   */
  readonly tenant: JobTenant<I>;
  /**
   * The endpoint this delivery is for. Read once PER ATTEMPT and never checkpointed: it carries a
   * secret, and a `step.run` output is written to `x_job_steps` — a credential in a durable table
   * the queue keeps for the life of the run.
   */
  endpoint(args: {
    readonly endpointId: string;
    /**
     * The delivery's own `orgId`, off the input — required by `OrgWebhookDeliveryInput`. Handed
     * over so a seam names its tenant from the work rather than reading it back off `ctx.actor`.
     */
    readonly orgId: I['orgId'];
    readonly ctx: Ctx;
  }): Promise<WebhookEndpoint | null> | WebhookEndpoint | null;
  /** The event's bytes. Read per attempt as well, out of the app's own table. */
  event(args: {
    readonly eventId: string;
    readonly orgId: I['orgId'];
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
  /**
   * The explicit opt-out from the address screen, for a receiver inside your own network — a dev
   * receiver on `localhost`, a service in the same cluster. Off by default: an endpoint URL is
   * tenant-supplied, and the screen is what stops it reaching the metadata service.
   */
  readonly allowPrivate?: boolean;
  /** Which environment decides whether `http:` is allowed. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How a hostname is resolved. Defaults to `Bun.dns.lookup`; injected in tests. */
  readonly resolve?: WebhookResolve;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /**
   * The ceiling for ONE attempt, and therefore for the request inside it. Deliberately not a
   * second per-request timeout: `ctx.signal` already carries this deadline into `fetch`, and two
   * numbers for one wait is the ambiguity axiom 1 refuses.
   */
  readonly timeout?: DurationInput;
}

export function webhook(
  definition: WebhookDefinition<OrgWebhookDeliveryInput> & {
    readonly tenant: (input: OrgWebhookDeliveryInput) => string;
  },
): JobHandle<OrgWebhookDeliveryInput>;
export function webhook(definition: WebhookDefinition): JobHandle<WebhookDeliveryInput>;
export function webhook(
  definition: WebhookDefinition<OrgWebhookDeliveryInput> | WebhookDefinition,
): JobHandle<WebhookDeliveryInput> {
  const clock = definition.clock ?? systemClock;
  const disableAfter = finiteOption(
    'webhook()',
    'disableAfter',
    definition.disableAfter ?? DEFAULT_WEBHOOK_DISABLE_AFTER,
  );
  const send = definition.fetch ?? ((url, init) => fetch(url, init));
  // The two seams at the base input. An org-tenant declaration's seams take `orgId: string`, and
  // they only ever run after `tenantOf` refused a delivery without one — so the org they are handed
  // is the one their type promises.
  const seams: Pick<WebhookDefinition, 'endpoint' | 'event'> = definition;

  // Named so `run` can read the deadline `job()` resolved — one parse of `timeout`, never two.
  const handle: JobHandle<WebhookDeliveryInput> = job<WebhookDeliveryInput>({
    name: definition.name,
    input: t.object({ endpointId: t.string, eventId: t.string, orgId: t.optional(t.string) }),
    // Endpoint AND event: the same event fans out to every subscribed endpoint, so a key on the
    // event alone would dedupe every one of those deliveries into the first endpoint's row.
    idempotencyKey: ({ endpointId, eventId }) => `${definition.name}:${endpointId}:${eventId}`,
    tenant: tenantOf(definition),
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    async run({ input, ctx, attempt }): Promise<WebhookReport> {
      // On the clock `executeJob`'s deadline timer runs on, read as the body starts — which is
      // when that timer is armed.
      const deadline =
        handle.timeoutMs === undefined
          ? undefined
          : {
              atMs: performance.now() + handle.timeoutMs,
              job: definition.name,
              timeoutMs: handle.timeoutMs,
            };
      const endpoint = await seams.endpoint({
        endpointId: input.endpointId,
        orgId: input.orgId,
        ctx,
      });
      if (endpoint === null) {
        throw new WebhookEndpointUnknownError({
          webhook: definition.name,
          endpointId: input.endpointId,
        });
      }
      // Before the ledger and before the socket: a disabled endpoint costs nothing, which is the
      // whole point of disabling one.
      // Asked of BOTH sources, because `disableAfter` writes only the ledger: an endpoint the
      // mechanism switched off must stop here whether or not the app mirrored it onto its row.
      if (endpoint.disabled === true || (await definition.ledger.isDisabled(endpoint.id))) {
        throw new WebhookEndpointDisabledError({
          webhook: definition.name,
          endpointId: endpoint.id,
        });
      }
      const url = assertDeliverable(definition.name, endpoint);
      // Screened and resolved before the event is read, let alone sent — see `webhook-target.ts`.
      const target = await webhookTarget({
        webhook: definition.name,
        endpointId: endpoint.id,
        url,
        allowPrivate: definition.allowPrivate === true,
        env: definition.env,
        resolve: definition.resolve ?? resolveWebhookHost,
      });

      const event = await seams.event({ eventId: input.eventId, orgId: input.orgId, ctx });
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
      // The last moment a cancelled attempt can stop without the receiver hearing anything — the
      // drain included: a POST not yet started is handed back to the next pod at no cost.
      stopIfCancelled(ctx);
      const startedAt = clock.monotonic();
      // Past this line the drain no longer cancels: see `deliverySignal`.
      const request = deliverySignal(ctx.signal, deadline);
      let outcome: Outcome;
      try {
        outcome = await ('unresolved' in target
          ? Promise.resolve({ ok: false as const, status: null, detail: target.unresolved })
          : attemptDelivery(
              send,
              endpoint,
              target,
              {
                secret: endpoint.secret,
                timestampSeconds,
                eventId: input.eventId,
                topic: event.topic,
                body: event.body,
              },
              request.signal,
            ));
      } finally {
        request.dispose();
      }
      const durationMs = Math.max(0, clock.monotonic() - startedAt);
      // A failure the REQUEST's cancellation caused is not the receiver's, and is not this
      // attempt's to record: the queue has already handed the delivery to another worker, whose
      // outcome is the one the consecutive count must hear. Recorded, it was a failure nobody saw
      // counting toward `disableAfter` — an abandoned attempt switching off a healthy endpoint.
      // Read off the request's signal, never the attempt's: a receiver that really failed while
      // the worker drained is a failure like any other, and the count hears it. A delivery that
      // LANDED is a fact, and is always recorded.
      if (!outcome.ok && request.signal.aborted) stopIfCancelled(ctx);

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
  return handle;
}

/**
 * The declared tenant, with the one refusal an org-owned delivery adds: a queued row with no
 * `orgId` — enqueued untyped, or before the org was added — names no org to run under, and is
 * refused before either seam reads anything. `assert`, as `jobTenantFor`'s empty-tenant refusal:
 * the repair is the enqueue, and the fix names it.
 */
function tenantOf(
  definition: WebhookDefinition<OrgWebhookDeliveryInput> | WebhookDefinition,
): JobTenant<WebhookDeliveryInput> {
  const declared = definition.tenant;
  if (typeof declared !== 'function') return declared;
  return (input) => {
    const { orgId } = input;
    assert(
      orgId !== undefined,
      `webhook "${definition.name}" declares an org tenant, and this delivery was enqueued with no orgId`,
      `enqueue it with the org that owns the endpoint: ${definition.name}.enqueue({ endpointId, eventId, orgId })`,
    );
    return declared({ ...input, orgId });
  };
}

/** A URL no delivery may open, or a secret that would make the POST unsigned. The parsed url. */
function assertDeliverable(name: string, endpoint: WebhookEndpoint): URL {
  if (endpoint.secret.length === 0) {
    throw new WebhookEndpointInvalidError({
      webhook: name,
      endpointId: endpoint.id,
      reason: 'has an empty secret, so the delivery would carry no proof of who sent it',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint.url);
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
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WebhookEndpointInvalidError({
      webhook: name,
      endpointId: endpoint.id,
      reason: `has a ${parsed.protocol} url, and a delivery only ever opens http: or https:`,
    });
  }
  return parsed;
}

/**
 * Throw the attempt's cancellation as itself — the deadline's `X_JOB_TIMEOUT`, the drain's
 * `X_DRAINING`, a lost lease — so `executeJob` reads the stop it caused, never a delivery failure
 * naming a receiver that did nothing wrong. Core's `X_ABORTED` when the reason carries no code.
 */
function stopIfCancelled(ctx: Ctx): void {
  if (!ctx.signal.aborted) return;
  const reason: unknown = ctx.signal.reason;
  if (isUltimateError(reason)) throw reason;
  throwIfAborted(ctx);
}
