// Single responsibility: OTLP/HTTP JSON logs (`/v1/logs`) — a `log.record` subscriber that batches
// the process logger's lines to a collector, each stamped with the span active when it was written.
// Installed by subscribing: `subscribe('log.record', (event) => logs.export(event.payload))`.

import { renderThrowable } from './error-render';
import type { LogRecordEvent } from './instrument-events';
import { logger } from './logger';
import {
  assertFiniteOtlpBound,
  OTLP_SCOPE,
  type OtlpKeyValue,
  type OtlpPostOptions,
  otlpAttributes,
  otlpEndpoint,
  otlpEndpointLabel,
  otlpHeaders,
  otlpResource,
  postOtlp,
  unixNano,
} from './otlp';
import { otlpBatcher } from './otlp-batch';
import {
  type AttributeValue,
  currentSpanContext,
  type SpanContext,
  type SpanResource,
  serviceResource,
} from './telemetry';

/** OTLP's `SeverityNumber`: the first number of each band. */
const SEVERITY = Object.freeze<Record<LogRecordEvent['level'], number>>({
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
});

/** One record as the exporter holds it: the event, and the span it was written under. */
export interface ExportedLogRecord {
  readonly record: LogRecordEvent;
  readonly span: SpanContext | undefined;
}

/** A field as an OTLP attribute. A nested value is its JSON — already redacted by the logger. */
function attributeOf(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return renderThrowable(value);
  }
}

function recordJson(entry: ExportedLogRecord): unknown {
  const { record, span } = entry;
  const attributes: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    const attribute = attributeOf(value);
    if (attribute !== undefined) attributes[key] = attribute;
  }
  // The synthetic context span (empty id) carries a trace id only: correlate on what exists.
  const ids =
    span === undefined
      ? {}
      : {
          traceId: span.traceId,
          ...(span.spanId === '' ? {} : { spanId: span.spanId }),
          flags: span.traceFlags & 0xff,
        };
  return {
    timeUnixNano: unixNano(record.at),
    observedTimeUnixNano: unixNano(record.at),
    severityNumber: SEVERITY[record.level],
    severityText: record.level.toUpperCase(),
    body: { stringValue: record.message },
    attributes: otlpAttributes(attributes) satisfies readonly OtlpKeyValue[],
    ...ids,
  };
}

/** Pure, so the wire format is a unit test rather than something discovered against a collector. */
export function otlpLogsRequest(
  records: readonly ExportedLogRecord[],
  resource: SpanResource,
): unknown {
  return {
    resourceLogs: [
      {
        resource: otlpResource(resource),
        scopeLogs: [{ scope: OTLP_SCOPE, logRecords: records.map(recordJson) }],
      },
    ],
  };
}

export interface OtlpLogExporterOptions {
  /** Overrides `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  readonly endpoint?: string | undefined;
  /** Merged over `OTEL_EXPORTER_OTLP_LOGS_HEADERS` (else `OTEL_EXPORTER_OTLP_HEADERS`). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Records per POST. Default 512, the OTel batch log processor's default. */
  readonly maxBatchSize?: number | undefined;
  /** Default 1000ms — the OTel batch log processor's schedule delay. */
  readonly flushIntervalMs?: number | undefined;
  /** Records held before the oldest are dropped. Default 2048. */
  readonly maxQueueSize?: number | undefined;
  /** Default 10000ms, the whole export, retries included. */
  readonly timeoutMs?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly sleep?: OtlpPostOptions['sleep'];
  readonly random?: OtlpPostOptions['random'];
  readonly now?: OtlpPostOptions['now'];
}

export interface OtlpLogExporter {
  /** Call from the `log.record` handler — synchronously, so the active span is the writer's. */
  export(record: LogRecordEvent): void;
  flush(): Promise<void>;
  /** Stop the timer and flush. Wire into `onShutdown('otlp', …, { phase: 'close' })`. */
  shutdown(): Promise<void>;
}

/**
 * The exporter's own complaints (`otlp export failed`, `otlp … dropped`) are not exported: with the
 * collector down they would be queued for the collector that is down, one more per interval.
 */
const OWN_LINES = /^otlp /;

/**
 * Throws `X_OTLP_ENDPOINT_INVALID` at construction when nothing configured an endpoint. Ask
 * `tryOtlpEndpoint('logs')` first when the exporter is optional.
 */
export function otlpLogExporter(options: OtlpLogExporterOptions = {}): OtlpLogExporter {
  const url = otlpEndpoint('logs', options.endpoint);
  const headers = otlpHeaders(options.headers, process.env, 'logs');
  const maxBatchSize = assertFiniteOtlpBound('maxBatchSize', options.maxBatchSize ?? 512);
  const maxQueueSize = assertFiniteOtlpBound('maxQueueSize', options.maxQueueSize ?? 2048);
  const timeoutMs = assertFiniteOtlpBound('timeoutMs', options.timeoutMs ?? 10_000);
  const flushIntervalMs = assertFiniteOtlpBound(
    'flushIntervalMs',
    options.flushIntervalMs ?? 1_000,
  );
  const send = options.fetch ?? globalThis.fetch;
  const seams = { sleep: options.sleep, random: options.random, now: options.now };

  const post = (batch: readonly ExportedLogRecord[]): Promise<void> => {
    let body: string;
    try {
      body = JSON.stringify(otlpLogsRequest(batch, serviceResource()));
    } catch (failure) {
      logger.warn('otlp log batch dropped', {
        url: otlpEndpointLabel(url),
        records: batch.length,
        error: renderThrowable(failure),
      });
      return Promise.resolve();
    }
    return postOtlp({ url, headers, body, timeoutMs, fetch: send, ...seams });
  };

  const batcher = otlpBatcher<ExportedLogRecord>({
    maxBatchSize,
    maxQueueSize,
    flushIntervalMs,
    post,
  });

  return {
    export(record: LogRecordEvent): void {
      if (OWN_LINES.test(record.message)) return;
      batcher.push({ record, span: currentSpanContext() });
    },
    flush: batcher.flush,
    shutdown: batcher.shutdown,
  };
}
