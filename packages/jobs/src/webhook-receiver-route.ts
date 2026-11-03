// The door `webhookReceiver()` mounts: read the bytes under `maxBytes`, ask `verify`, enqueue the
// payload it verified durably, and only then answer 200 `{ ok, eventId, deduped }`. Nothing is
// parsed before `verify` and no content type is required. An enqueue failure is 503 with
// `Retry-After`, so the vendor redelivers: an ack never precedes the durable row.

import { readWithinLimit } from '@ultimat3/core';
import type { Route, RouteHandler, RouteMeta, UltimateRequest } from '@ultimat3/http';
import { HttpError, jsonResponse } from '@ultimat3/http';
import type { JsonValue } from '@ultimat3/schema';
import type { JobHandle } from './job';
import {
  WEBHOOK_EVENT_ID_PATTERN,
  WebhookEventIdInvalidError,
  WebhookReceiverUnavailableError,
} from './webhook-receiver-errors';
import type {
  WebhookInbound,
  WebhookReceiverDefinition,
  WebhookReceiverInput,
} from './webhook-receiver-types';

interface RouteSpec<P extends JsonValue> {
  readonly definition: WebhookReceiverDefinition<P>;
  readonly maxBytes: number;
  readonly handle: JobHandle<WebhookReceiverInput>;
}

async function inboundOf(
  request: UltimateRequest,
  name: string,
  maxBytes: number,
): Promise<WebhookInbound> {
  // Core's counting reader, NOT `bodyBytes()`: that one caps at `http.bodyLimitBytes`, and a
  // receiver's own `maxBytes` is the number this route answers to, in either direction.
  const read =
    request.method === 'GET'
      ? { bytes: new Uint8Array(0) }
      : await readWithinLimit(request.raw.body, maxBytes);
  if ('over' in read) {
    throw new HttpError({
      code: 'X_BODY_INVALID',
      cause: `${request.pathname} body rejected: body is at least ${read.over} bytes, limit is ${maxBytes}`,
      fix: `webhookReceiver({ name: '${name}', maxBytes: ${maxBytes * 2}, … }) — raise maxBytes to the largest delivery the vendor sends`,
      meta: { maxBytes },
    });
  }
  const { bytes } = read;
  const raw = request.raw;
  return {
    bytes,
    headers: raw.headers,
    params: request.params,
    url: request.url,
    request: () =>
      new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        ...(request.method === 'GET' ? {} : { body: new Uint8Array(bytes) }),
      }),
  };
}

export function receiverRoutes<P extends JsonValue>(spec: RouteSpec<P>): readonly Route[] {
  const { definition, maxBytes, handle } = spec;
  const rate = definition.rateLimit;
  const meta: RouteMeta = {
    name: `webhook.${definition.name}`,
    // A vendor carries no session: the credential is the signature `verify` checks.
    auth: 'public',
    ...(rate === undefined
      ? {}
      : typeof rate === 'string'
        ? { rateLimit: rate }
        : { rateLimit: `webhook.${definition.name}`, rateLimitBucket: rate }),
  };

  const receive: RouteHandler = async (request) => {
    const inbound = await inboundOf(request, definition.name, maxBytes);
    const verified = await definition.verify(inbound);
    if ('answer' in verified) return verified.answer;
    // Bounded before it is a key, a response field or a cause: `typeof` first, because `verify`
    // is app code and JS callers return what they like.
    const eventId: unknown = verified.eventId;
    if (typeof eventId !== 'string' || !WEBHOOK_EVENT_ID_PATTERN.test(eventId)) {
      throw new WebhookEventIdInvalidError({
        receiver: definition.name,
        length: typeof eventId === 'string' ? eventId.length : 0,
      });
    }
    const row: WebhookReceiverInput = {
      eventId,
      ...(verified.orgId === undefined ? {} : { orgId: verified.orgId }),
      ...(verified.topic === undefined ? {} : { topic: verified.topic }),
      payload: verified.payload,
    };
    // Outside the try: an org receiver whose `verify` named no org is the app's to fix, and a 503
    // would have the vendor retry it forever.
    const tenantId = handle.tenantFor(row);
    let enqueued: Awaited<ReturnType<typeof handle.enqueue>>;
    try {
      // `outbox: false`: the row must be durable BEFORE the ack, never staged behind a commit.
      enqueued = await handle.enqueue(row, {
        outbox: false,
        ...(tenantId === undefined ? {} : { tenantId }),
      });
    } catch (error) {
      throw new WebhookReceiverUnavailableError({
        receiver: definition.name,
        eventId: row.eventId,
        error,
      });
    }
    return jsonResponse({ ok: true, eventId: row.eventId, deduped: enqueued.deduped });
  };

  const routes: Route[] = [{ method: 'POST', path: definition.path, handler: receive, meta }];
  const handshake = definition.handshake;
  if (handshake !== undefined) {
    routes.push({
      method: 'GET',
      path: definition.path,
      meta: { ...meta, name: `webhook.${definition.name}.handshake` },
      handler: async (request) => handshake(await inboundOf(request, definition.name, maxBytes)),
    });
  }
  return routes;
}
