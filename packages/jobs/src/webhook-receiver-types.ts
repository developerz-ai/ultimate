// The shapes `webhookReceiver()` speaks: what `verify` is handed and answers, what the queue row
// holds, and what `handle` receives. Apart from the factory so each file keeps one job.

import type { Ctx } from '@ultimat3/core';
import type { Bucket, Route } from '@ultimat3/http';
import type { JsonValue } from '@ultimat3/schema';
import type { JobHandle } from './job';
import type { RetryPolicy } from './retry';
import type { StepApi } from './steps-api';

/** What `verify` and `handshake` are handed: the request as bytes, nothing parsed. */
export interface WebhookInbound {
  /** The body exactly as sent, read under `maxBytes`. Empty for the GET handshake. */
  readonly bytes: Uint8Array;
  readonly headers: Headers;
  /** The `:param` segments of `path` — a per-credential token, an account id. */
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
  /** A fresh `Request` over the same bytes, for `verifyWebhookSignature` or a mail receiver. */
  request(): Request;
}

/** Who the event is for, as `verify` read it — what `tenant` decides from. */
export interface ReceivedEventFacts {
  /**
   * The dedupe key, and therefore the replay key: read it out of VERIFIED data — the signed bytes
   * `verifyBodyHmac` answers (`.text`), or a header the mac covers — after the signature check,
   * never from an unsigned header. An unsigned id lets one captured signature replay forever under
   * fresh ids. 1-256 printable ASCII characters, else `X_WEBHOOK_EVENT_ID_INVALID` (422).
   */
  readonly eventId: string;
  readonly orgId?: string | undefined;
  readonly topic?: string | undefined;
}

/**
 * `verify` accepted the bytes. `payload` is what it read out of them AFTER the signature check —
 * the job stores it and `handle` receives it, so no retry re-verifies against a window that has
 * closed. JSON, because it is a queue row.
 */
export interface ReceivedEvent<P extends JsonValue = JsonValue> extends ReceivedEventFacts {
  readonly payload: P;
}

/** `verify` answered the request itself — a subscription confirm, a challenge. Nothing queues. */
export interface WebhookAnswer {
  readonly answer: Response;
}

/** The queue row. `payload` is `.sensitive()`, so an operator never reads it. */
export interface WebhookReceiverInput {
  readonly eventId: string;
  readonly orgId?: string | undefined;
  readonly topic?: string | undefined;
  readonly payload: JsonValue;
}

export interface WebhookHandleArgs<P extends JsonValue = JsonValue> {
  readonly eventId: string;
  readonly orgId: string | undefined;
  readonly topic: string | undefined;
  /** What `verify` answered, already verified. Never re-verify here: the vendor's window closes. */
  readonly payload: P;
  readonly ctx: Ctx;
  readonly step: StepApi;
  readonly attempt: number;
}

/** Who a receiver's run acts as: `'none'`, or the org `verify` named. */
export type WebhookReceiverTenant = 'none' | ((event: ReceivedEventFacts) => string | undefined);

export interface WebhookReceiverDefinition<P extends JsonValue = JsonValue> {
  /** The job's durable name and the route's `webhook.<name>`. Required: it is a queue key. */
  readonly name: string;
  /** Absolute, may hold `:param`; never under `/api` or `/_x`, which the framework serves. */
  readonly path: string;
  readonly tenant: WebhookReceiverTenant;
  /** Throws to refuse (`X_WEBHOOK_SIGNATURE_INVALID`); runs before anything is parsed. */
  verify(
    inbound: WebhookInbound,
  ): Promise<ReceivedEvent<P> | WebhookAnswer> | ReceivedEvent<P> | WebhookAnswer;
  /** The job's body. At least once per `eventId`. */
  handle(args: WebhookHandleArgs<P>): Promise<unknown>;
  /** Mounts `GET path` answering what this returns. Unset, no GET route exists. */
  handshake?(inbound: WebhookInbound): Promise<Response> | Response;
  readonly retry?: RetryPolicy;
  readonly queue?: string;
  /** Defaults to `DEFAULT_WEBHOOK_BODY_LIMIT` (1 MiB), enforced while the body streams. */
  readonly maxBytes?: number;
  /** A bucket name from `rateLimit.buckets`, or the route's own numbers. */
  readonly rateLimit?: string | Bucket;
}

/** The job handle, plus its routes — mounted by the boot for every receiver the app declares. */
export interface WebhookReceiver extends JobHandle<WebhookReceiverInput> {
  routes(): readonly Route[];
}
