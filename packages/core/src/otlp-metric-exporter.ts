// Single responsibility: a `MetricExporter` that POSTs OTLP/HTTP JSON to a collector. No batching
// — `collectMetrics()` already produces one whole snapshot per tick, so a tick is a request.

import { renderThrowable } from './error-render';
import { logger } from './logger';
import type {
  HistogramPoint,
  MetricCollection,
  MetricExporter,
  MetricPoint,
  ReadableMetric,
} from './metrics';
import {
  OTLP_SCOPE,
  otlpAttributes,
  otlpEndpoint,
  otlpHeaders,
  otlpResource,
  postOtlp,
  unixNano,
} from './otlp';

/** `AGGREGATION_TEMPORALITY_CUMULATIVE`. The only temporality `metrics.ts` produces. */
const CUMULATIVE = 2;

function isHistogramPoint(point: MetricPoint): point is HistogramPoint {
  return 'buckets' in point;
}

function numberPoint(point: MetricPoint, at: string, startedAt: string): unknown {
  return {
    attributes: otlpAttributes(point.attributes),
    startTimeUnixNano: startedAt,
    timeUnixNano: at,
    asDouble: point.value,
  };
}

function histogramDataPoint(point: HistogramPoint, at: string, startedAt: string): unknown {
  return {
    attributes: otlpAttributes(point.attributes),
    startTimeUnixNano: startedAt,
    timeUnixNano: at,
    count: String(point.count),
    sum: point.value,
    // 64-bit counts, so the JSON encoding spells them as strings — the same rule `intValue` follows.
    bucketCounts: point.buckets.map((count) => String(count)),
    explicitBounds: [...point.bounds],
    ...(point.count === 0 ? {} : { min: point.min, max: point.max }),
  };
}

function metricJson(metric: ReadableMetric, at: string, startedAt: string): unknown {
  const { name, unit, description, kind } = metric.descriptor;
  const head = { name, unit, description };
  if (kind === 'histogram') {
    const dataPoints = metric.points
      .filter(isHistogramPoint)
      .map((point) => histogramDataPoint(point, at, startedAt));
    return { ...head, histogram: { dataPoints, aggregationTemporality: CUMULATIVE } };
  }
  const dataPoints = metric.points.map((point) => numberPoint(point, at, startedAt));
  if (kind === 'gauge') return { ...head, gauge: { dataPoints } };
  return {
    ...head,
    sum: { dataPoints, aggregationTemporality: CUMULATIVE, isMonotonic: true },
  };
}

/**
 * Pure, so the wire format is a unit test. `startedAt` is the process start: cumulative points
 * carry the instant the sum began, and a reader that sees it move knows the process restarted —
 * which is the whole reason OTLP carries it separately from the observation time.
 */
export function otlpMetricsRequest(collection: MetricCollection, startedAtMs: number): unknown {
  const at = unixNano(collection.at);
  const startedAt = unixNano(startedAtMs);
  return {
    resourceMetrics: [
      {
        resource: otlpResource(collection.resource),
        scopeMetrics: [
          {
            scope: OTLP_SCOPE,
            metrics: collection.metrics.map((metric) => metricJson(metric, at, startedAt)),
          },
        ],
      },
    ],
  };
}

export interface OtlpMetricExporterOptions {
  /** Overrides `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  readonly endpoint?: string | undefined;
  /** Merged over `OTEL_EXPORTER_OTLP_HEADERS`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Default 10000ms. */
  readonly timeoutMs?: number | undefined;
  /** Injected by tests; the preload seals the real one. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /**
   * Epoch ms this process's counters started at. Defaults to the first export, which is close
   * enough for a rate and exact for a restart detector; pass the boot time when you have it.
   */
  readonly startedAtMs?: number | undefined;
}

export interface OtlpMetricExporter extends MetricExporter {
  /** Resolves once the last POST settles — `exportMetrics()` itself is fire-and-forget. */
  flush(): Promise<void>;
}

/**
 * Throws `X_OTLP_ENDPOINT_INVALID` at construction when nothing configured an endpoint. Ask
 * `tryOtlpEndpoint('metrics')` first when the exporter is optional.
 */
export function otlpMetricExporter(options: OtlpMetricExporterOptions = {}): OtlpMetricExporter {
  const url = otlpEndpoint('metrics', options.endpoint);
  const headers = otlpHeaders(options.headers);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const send = options.fetch ?? globalThis.fetch;
  let startedAtMs = options.startedAtMs;
  let inflight: Promise<void> = Promise.resolve();

  return {
    export(collection: MetricCollection): void {
      startedAtMs ??= collection.at;
      let body: string;
      try {
        // `export` is called from a timer, not awaited by anyone, so this throw had nowhere to go
        // but into the metric loop that called it: `MetricAttributeValue` is a compile-time claim,
        // and an attribute the app spelled as an object or a bigint reaches `otlpAttributes` as a
        // TypeError. Dropped with a line, the same degradation `postOtlp` already applies to a
        // collector that is down — telemetry is best-effort and must never end the process.
        body = JSON.stringify(otlpMetricsRequest(collection, startedAtMs));
      } catch (failure) {
        logger.warn('otlp metric snapshot dropped', {
          url,
          metrics: collection.metrics.length,
          error: renderThrowable(failure),
        });
        return;
      }
      // Chained, so a slow collector cannot make two snapshots arrive out of order and turn a
      // cumulative counter into an apparent reset. Chained on a SETTLED shadow, for the reason
      // `otlp-span-exporter.ts` spells out: a chain that carries a rejection forward stops calling
      // `postOtlp` for the life of the process, in silence.
      const settled = inflight.then(
        () => undefined,
        () => undefined,
      );
      inflight = settled.then(() => postOtlp({ url, headers, body, timeoutMs, fetch: send }));
    },
    flush(): Promise<void> {
      return inflight;
    },
  };
}
