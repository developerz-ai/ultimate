// The two ids a caller may bring, read from the raw headers BEFORE the context or the root span
// exists. Both used to be parsed by a stage that ran one frame after `withSpan` had already
// frozen the span's context: the caller's trace was discarded, the root span carried a fresh
// UUIDv7 no collector accepts as a trace id, and the log lines quoted a third value.

import { traceId as newTraceId, parseTraceparent, type SpanContext, uuid } from '@ultimat3/core';
import type { HttpConfig } from './config';

/**
 * What an inbound `x-request-id` must look like to be echoed. A caller choosing this value
 * chooses a key in the log store, so it is bounded and boring on purpose — and only read at all
 * when `trustProxy` says a proxy in front of us is what writes it.
 */
const REQUEST_ID = /^[\w.:-]{8,128}$/;

export interface InboundCorrelation {
  readonly requestId: string;
  /** W3C trace id: the caller's when it sent one, otherwise a fresh 32-hex id. */
  readonly traceId: string;
  readonly parentSpanId: string | null;
  /**
   * The caller's span, to hand to `withSpan({ parent })`. `undefined` starts a new trace —
   * `startSpan` must not fall back to `currentSpanContext()` for a request, because that reads
   * the context's own `traceId` and produces a root span with no parent and a made-up trace.
   */
  readonly parent: SpanContext | undefined;
}

/**
 * Read once per request, before `runWithContext`. `parseTraceparent` is core's — one regex for
 * the wire format, in the package that also writes it (`traceparent()`), so an outbound header
 * and an inbound one cannot drift.
 */
export const readCorrelation = (headers: Headers, config: HttpConfig): InboundCorrelation => {
  const inboundId = config.trustProxy ? headers.get('x-request-id') : null;
  const requestId = inboundId !== null && REQUEST_ID.test(inboundId) ? inboundId : uuid();
  const parent = parseTraceparent(headers.get('traceparent'));
  return {
    requestId,
    traceId: parent?.traceId ?? newTraceId(),
    parentSpanId: parent?.spanId ?? null,
    parent,
  };
};
