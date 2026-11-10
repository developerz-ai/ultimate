// The harness both `webhookReceiver()` suites drive: a vendor-style receiver (hmac over the body
// in `x-vendor-signature`) mounted in the REAL `httpPipeline`, a worker over whichever driver the
// suite installs, and a record of what `verify` and `handle` were handed. Test-only.

import { type Ctx, ctxOf, frozenClock, hmac } from '@ultimat3/core';
import type { Pipeline } from '@ultimat3/http';
import { defineHttpConfig, httpPipeline, httpRouter, verifyBodyHmac } from '@ultimat3/http';
import type { JsonValue } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { webhookReceiver } from './webhook-receiver';
import type { WebhookReceiver, WebhookReceiverDefinition } from './webhook-receiver-types';
import type { Worker } from './worker';
import { jobWorker } from './worker';

export const VENDOR_SECRET = 'whsec_vendor_never_leaks';
export const SIGNATURE_HEADER = 'x-vendor-signature';

export const sign = (bytes: Uint8Array | string): string =>
  hmac('sha256', VENDOR_SECRET, bytes, 'hex');

export interface Seen {
  readonly verified: { bytes: Uint8Array; params: Readonly<Record<string, string>> }[];
  readonly handled: { eventId: string; payload: JsonValue; attempt: number }[];
}

export interface ReceiverHarness {
  readonly receiver: WebhookReceiver;
  readonly pipeline: Pipeline;
  readonly seen: Seen;
  /** POST the bytes, signed unless `signature` says otherwise. */
  post(
    path: string,
    body: Uint8Array | string,
    init?: { contentType?: string; signature?: string; eventId?: string },
  ): Promise<Response>;
  worker(driver: JobDriver): Worker;
}

let minted = 0;

export function receiverHarness(
  over: Partial<WebhookReceiverDefinition<JsonValue>> = {},
): ReceiverHarness {
  minted += 1;
  const seen: Seen = { verified: [], handled: [] };
  const receiver = webhookReceiver({
    name: `vendor-events-${minted}`,
    path: '/hooks/vendor/:account',
    tenant: 'none',
    verify: (inbound) => {
      seen.verified.push({ bytes: inbound.bytes, params: inbound.params });
      const { text } = verifyBodyHmac({
        bytes: inbound.bytes,
        secret: VENDOR_SECRET,
        given: inbound.headers.get(SIGNATURE_HEADER),
        encoding: 'hex',
      });
      // A test harness: the id rides a header so a case can name it. An app reads it from `text`.
      const eventId = inbound.headers.get('x-vendor-event') ?? 'evt_1';
      return { eventId, topic: 'invoice.paid', payload: { text } };
    },
    handle: ({ eventId, payload, attempt }) => {
      seen.handled.push({ eventId, payload, attempt });
      return Promise.resolve({ eventId });
    },
    retry: { attempts: 1, jitter: 'none' },
    ...over,
  });
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });
  const pipeline = httpPipeline({ table: httpRouter(receiver.routes()), config });
  return {
    receiver,
    pipeline,
    seen,
    async post(path, body, init = {}) {
      const headers: Record<string, string> = {
        [SIGNATURE_HEADER]: init.signature ?? sign(body),
        ...(init.eventId === undefined ? {} : { 'x-vendor-event': init.eventId }),
        ...(init.contentType === undefined ? {} : { 'content-type': init.contentType }),
      };
      const response = await pipeline.handle(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers,
          body: typeof body === 'string' ? body : new Uint8Array(body),
        }),
        { role: 'web' },
      );
      return response;
    },
    worker(driver) {
      const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });
      return jobWorker({
        driver,
        workerId: `receiver-worker-${minted}`,
        concurrency: 1,
        visibilityTimeoutMs: 30_000,
        heartbeatIntervalMs: 3_600_000,
        pollIntervalMs: 0,
        context,
        drainOnShutdown: false,
        clock: frozenClock('2026-11-03T00:00:00.000Z'),
      });
    },
  };
}
