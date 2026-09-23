// Single responsibility: a `SpanExporter` that POSTs OTLP/HTTP JSON to a collector. Batched,
// because `SpanExporter.export` is one span and a request per span is a second load generator.

import { renderThrowable } from './error-render';
import { logger } from './logger';
import {
  assertFiniteOtlpBound,
  OTLP_SCOPE,
  type OtlpKeyValue,
  otlpAttributes,
  otlpEndpoint,
  otlpHeaders,
  otlpResource,
  postOtlp,
  unixNano,
} from './otlp';
import type {
  ReadableSpan,
  SpanContext,
  SpanExporter,
  SpanKind,
  SpanResource,
  SpanStatusCode,
} from './telemetry';

/** OTLP's `SpanKind` enum; `UNSPECIFIED` is 0 and Ultimate never emits it. */
const SPAN_KIND = Object.freeze<Record<SpanKind, number>>({
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
});

const STATUS_CODE = Object.freeze<Record<SpanStatusCode, number>>({
  unset: 0,
  ok: 1,
  error: 2,
});

interface OtlpSpanJson {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpKeyValue[];
  readonly events: readonly unknown[];
  readonly links: readonly unknown[];
  readonly status: { readonly code: number; readonly message?: string };
}

function link(context: SpanContext): unknown {
  return { traceId: context.traceId, spanId: context.spanId };
}

function spanJson(span: ReadableSpan): OtlpSpanJson {
  return {
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    kind: SPAN_KIND[span.kind],
    startTimeUnixNano: unixNano(span.startedAt),
    endTimeUnixNano: unixNano(span.endedAt),
    attributes: otlpAttributes(span.attributes),
    events: span.events.map((event) => ({
      timeUnixNano: unixNano(event.at),
      name: event.name,
      attributes: otlpAttributes(event.attributes),
    })),
    links: span.links.map(link),
    status: {
      code: STATUS_CODE[span.status.code],
      ...(span.status.message === undefined ? {} : { message: span.status.message }),
    },
  };
}

/**
 * Pure, so the wire format is a unit test rather than something discovered against a collector.
 * Spans are grouped by resource identity — in one process there is exactly one, but grouping here
 * keeps the shape correct if a future caller replays spans from elsewhere.
 */
export function otlpTraceRequest(spans: readonly ReadableSpan[], resource: SpanResource): unknown {
  return {
    resourceSpans: [
      {
        resource: otlpResource(resource),
        scopeSpans: [{ scope: OTLP_SCOPE, spans: spans.map(spanJson) }],
      },
    ],
  };
}

export interface OtlpSpanExporterOptions {
  /** Overrides `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  readonly endpoint?: string | undefined;
  /** Merged over `OTEL_EXPORTER_OTLP_HEADERS`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Spans per POST. Default 512, the OTel batch processor's own default. */
  readonly maxBatchSize?: number | undefined;
  /** Default 5000ms. */
  readonly flushIntervalMs?: number | undefined;
  /** Spans held before the oldest are dropped. Default 2048 — a bound, not a promise. */
  readonly maxQueueSize?: number | undefined;
  /** Default 10000ms. */
  readonly timeoutMs?: number | undefined;
  /** Injected by tests; the preload seals the real one. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface OtlpSpanExporter extends SpanExporter {
  /** Send whatever is queued now. Resolves once the POST settles. */
  flush(): Promise<void>;
  /** Stop the timer and flush. Wire this into `onShutdown('otlp', …, { phase: 'close' })`. */
  shutdown(): Promise<void>;
}

/**
 * Throws `X_OTLP_ENDPOINT_INVALID` at construction when nothing configured an endpoint — a
 * telemetry exporter that silently sends nowhere is the failure this whole seam exists to end.
 * Ask `tryOtlpEndpoint('traces')` first when the exporter is optional.
 */
export function otlpSpanExporter(options: OtlpSpanExporterOptions = {}): OtlpSpanExporter {
  const url = otlpEndpoint('traces', options.endpoint);
  const headers = otlpHeaders(options.headers);
  const maxBatchSize = assertFiniteOtlpBound('maxBatchSize', options.maxBatchSize ?? 512);
  const maxQueueSize = assertFiniteOtlpBound('maxQueueSize', options.maxQueueSize ?? 2048);
  const timeoutMs = assertFiniteOtlpBound('timeoutMs', options.timeoutMs ?? 10_000);
  const flushIntervalMs = assertFiniteOtlpBound(
    'flushIntervalMs',
    options.flushIntervalMs ?? 5_000,
  );
  const send = options.fetch ?? globalThis.fetch;
  const queue: ReadableSpan[] = [];
  /** The ONE batch in flight, or `undefined`. Never a chain: see `pump`. */
  let sending: Promise<void> | undefined;

  const post = (batch: readonly ReadableSpan[]): Promise<void> => {
    const first = batch[0];
    if (first === undefined) return Promise.resolve();
    let body: string;
    try {
      // The one synchronous throw on this path, and the only way a send could reject at all:
      // `AttributeValue` is a compile-time claim, so an attribute the app spelled as an object, a
      // bigint or a cycle reaches `anyValue`'s `value.map(...)` as a TypeError. Dropped with a
      // line, the same degradation `postOtlp` already applies to a collector that is down —
      // telemetry is best-effort and must never become the process's exit code.
      body = JSON.stringify(otlpTraceRequest(batch, first.resource));
    } catch (failure) {
      logger.warn('otlp span batch dropped', {
        url,
        spans: batch.length,
        error: renderThrowable(failure),
      });
      return Promise.resolve();
    }
    return postOtlp({ url, headers, body, timeoutMs, fetch: send });
  };

  /**
   * At most ONE batch in flight, and at most `maxBatchSize` spans in it. The queue used to be
   * moved wholesale into a promise chain behind the previous POST, so a stalled collector held
   * every span ever exported — 100k with `maxQueueSize: 2048` — and the bound was a bound on the
   * queue, not on memory. Now spans WAIT IN the queue while a POST is unsettled, where drop-oldest
   * applies, and what is held is `maxQueueSize` plus one batch. One at a time also keeps batches
   * in order, so a parent span never arrives after its child. A POST cannot reject (`postOtlp`
   * degrades to a log line) and `post` catches its own serialisation throw, so nothing here can
   * poison the next send.
   */
  const pump = (): Promise<void> => {
    if (sending !== undefined) return sending;
    const batch = queue.splice(0, maxBatchSize);
    if (batch.length === 0) return Promise.resolve();
    const current = post(batch).then(
      () => undefined,
      () => undefined,
    );
    sending = current.then(() => {
      sending = undefined;
      // A full batch waiting behind a slow POST goes next without waiting for the timer.
      if (queue.length >= maxBatchSize) void pump();
    });
    return sending;
  };

  /** Everything queued NOW, batch by batch. Bounded, so a busy exporter cannot keep it looping. */
  const drainQueue = async (): Promise<void> => {
    let rounds = Math.ceil(queue.length / maxBatchSize) + 1;
    while (rounds > 0) {
      rounds -= 1;
      await pump();
      if (queue.length === 0 && sending === undefined) return;
    }
  };

  // Unref'd, so a pending flush never holds a draining process open — `shutdown()` is what
  // decides the last batch leaves, exactly as `startMetricExport` defers to the drain hook.
  // `pump`, never `drainQueue`: while a POST is stalled `pump` answers the send already in flight
  // and allocates nothing, where a drain per tick would park one more waiter per interval.
  const timer = setInterval(() => void pump(), flushIntervalMs);
  timer.unref();

  return {
    export(span: ReadableSpan): void {
      // Drop the OLDEST: a bounded queue that drops the newest keeps a stale window forever, and
      // the spans an operator wants during an incident are the ones happening now.
      if (queue.length >= maxQueueSize) queue.shift();
      queue.push(span);
      if (queue.length >= maxBatchSize) void pump();
    },
    flush(): Promise<void> {
      return drainQueue();
    },
    async shutdown(): Promise<void> {
      clearInterval(timer);
      await drainQueue();
    },
  };
}
