// Single responsibility: the OpenTelemetry-shaped metric DATA MODEL — what a point, a
// descriptor, a collection and an instrument's options are. No registry and no state: `metrics.ts`
// owns those, and a reader (`metrics-text.ts`, an exporter) needs the shapes without them.

import type { SpanResource } from './telemetry';

export type MetricKind = 'counter' | 'gauge' | 'histogram';

/**
 * Narrower than a span attribute on purpose: metric attributes become time-series labels, every
 * distinct combination is a stored series, and an array label has no meaning in any exposition
 * format. Keep the cardinality low — a user id here is an outage, and `maxSeries` is the ceiling
 * that makes "keep it low" a mechanism instead of this sentence.
 */
export type MetricAttributeValue = string | number | boolean;

export interface MetricAttributes {
  readonly [key: string]: MetricAttributeValue;
}

export interface MetricDescriptor {
  readonly name: string;
  readonly kind: MetricKind;
  /** UCUM, as OTel spells it: `1`, `s`, `By`, `{request}`. */
  readonly unit: string;
  readonly description: string;
}

export interface MetricPoint {
  readonly attributes: MetricAttributes;
  /** Counter: cumulative sum since process start. Gauge: last value. Histogram: sum. */
  readonly value: number;
}

export interface HistogramPoint extends MetricPoint {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  /** Explicit upper bounds; `buckets` is one longer, the last being the `+Inf` overflow. */
  readonly bounds: readonly number[];
  readonly buckets: readonly number[];
}

export interface ReadableMetric {
  readonly descriptor: MetricDescriptor;
  readonly points: readonly MetricPoint[];
}

export interface MetricCollection {
  /** Epoch milliseconds, from the configured clock. */
  readonly at: number;
  readonly resource: SpanResource;
  readonly metrics: readonly ReadableMetric[];
}

/** The driver seam. OTLP, Prometheus remote-write or a vendor SDK all arrive as one of these. */
export interface MetricExporter {
  export(collection: MetricCollection): void;
}

export interface Counter {
  add(value?: number, attributes?: MetricAttributes): void;
}

export interface Gauge {
  /** Set the current value. */
  record(value: number, attributes?: MetricAttributes): void;
  /** Move the current value — `+1` on connect, `-1` on disconnect. */
  add(delta: number, attributes?: MetricAttributes): void;
}

export interface Histogram {
  record(value: number, attributes?: MetricAttributes): void;
}

export interface InstrumentOptions {
  readonly unit?: string | undefined;
  readonly description?: string | undefined;
  /**
   * Distinct label sets this instrument may store. Past it every new set folds into one overflow
   * series. Defaults to `DEFAULT_MAX_SERIES`; the first declaration of a name wins.
   */
  readonly maxSeries?: number | undefined;
}

export interface GaugeOptions extends InstrumentOptions {
  /**
   * Async instrument: read at collection time instead of being pushed. Never stale.
   * Stated twice for one name with two different callbacks is `X_METRIC_NAME_INVALID`, not a
   * silent win for the first — see `assertSameDeclaration`.
   */
  readonly observe?: (() => number) | undefined;
}

export interface HistogramOptions extends InstrumentOptions {
  /**
   * Explicit bucket boundaries, ascending. Defaults to the OTel latency-in-seconds set.
   * Stated twice for one name with two different sets is `X_METRIC_NAME_INVALID`, not a silent
   * win for the first — see `assertSameDeclaration`.
   */
  readonly bounds?: readonly number[] | undefined;
}
