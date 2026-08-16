// Single responsibility: the OpenTelemetry-shaped metrics seam — counter, gauge and histogram
// aggregated in process, read through one `collectMetrics()`. Shaped exactly like `telemetry.ts`:
// always on, a no-op exporter by default, and the wire format supplied by a driver, never here.

import { type Clock, systemClock } from './clock';
import { type CodedErrorInit, UltimateError } from './errors';
import { logger } from './logger';
import { type SpanResource, serviceResource } from './telemetry';

export class MetricNameInvalidError extends UltimateError {
  static readonly code = 'X_METRIC_NAME_INVALID';
  override readonly name = 'MetricNameInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: MetricNameInvalidError.code });
  }
}

export class MetricValueInvalidError extends UltimateError {
  static readonly code = 'X_METRIC_VALUE_INVALID';
  override readonly name = 'MetricValueInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: MetricValueInvalidError.code });
  }
}

export class MetricCardinalityError extends UltimateError {
  static readonly code = 'X_METRIC_CARDINALITY';
  override readonly name = 'MetricCardinalityError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: MetricCardinalityError.code });
  }
}

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
  /** Async instrument: read at collection time instead of being pushed. Never stale. */
  readonly observe?: (() => number) | undefined;
}

export interface HistogramOptions extends InstrumentOptions {
  /** Explicit bucket boundaries, ascending. Defaults to the OTel latency-in-seconds set. */
  readonly bounds?: readonly number[] | undefined;
}

/**
 * The per-instrument series ceiling. 2000 is roomy for a bounded label set — every route pattern
 * times every status class times every method — and small enough that the process notices an
 * unbounded one long before the scrape body does.
 */
export const DEFAULT_MAX_SERIES = 2000;

/**
 * The label the folded series carries. OTel's own cardinality-limit spelling, deliberately NOT
 * `__overflow`: Prometheus treats `__`-prefixed labels as internal and strips them during
 * relabeling, so an overflow series named that way would merge back into the unlabelled series
 * and the drop would be invisible in exactly the place it has to be visible.
 */
export const OVERFLOW_ATTRIBUTE = 'otel_metric_overflow';

const OVERFLOW_ATTRIBUTES: MetricAttributes = Object.freeze({ [OVERFLOW_ATTRIBUTE]: true });

/** OTel's default explicit bucket boundaries for a duration histogram, in seconds. */
export const DEFAULT_HISTOGRAM_BOUNDS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]);

/**
 * Lowercase snake, the intersection of what every exposition format accepts. OTel's dotted names
 * survive an OTLP hop but not a Prometheus scrape, and the autoscaler reads the scrape.
 */
const METRIC_NAME_RE = /^[a-z_][a-z0-9_]*$/;

export const noopMetricExporter: MetricExporter = Object.freeze({
  export(): void {
    // Intentionally empty: instruments are always live, and free until an exporter is configured.
  },
});

export interface MemoryMetricExporter extends MetricExporter {
  readonly collections: readonly MetricCollection[];
  reset(): void;
}

/** For tests: assert an export tick without a collector. `metricsText()` is the shipped read. */
export function memoryMetricExporter(): MemoryMetricExporter {
  const collections: MetricCollection[] = [];
  return {
    collections,
    export(collection: MetricCollection): void {
      collections.push(collection);
    },
    reset(): void {
      collections.length = 0;
    },
  };
}

export interface MetricsOptions {
  readonly exporter?: MetricExporter | undefined;
  readonly clock?: Clock | undefined;
  readonly enabled?: boolean | undefined;
}

interface Series {
  readonly attributes: MetricAttributes;
  value: number;
  count: number;
  min: number;
  max: number;
  buckets: number[];
}

interface Instrument {
  readonly descriptor: MetricDescriptor;
  readonly series: Map<string, Series>;
  readonly bounds: readonly number[];
  readonly observe: (() => number) | undefined;
  readonly maxSeries: number;
  /** Reported once. A cardinality blow-up is one bug, not one log line per call. */
  overflowed: boolean;
}

const instruments = new Map<string, Instrument>();

let exporter: MetricExporter = noopMetricExporter;
let clock: Clock = systemClock;
let enabled = true;

export function configureMetrics(options: MetricsOptions): void {
  if (options.exporter !== undefined) exporter = options.exporter;
  if (options.clock !== undefined) clock = options.clock;
  if (options.enabled !== undefined) enabled = options.enabled;
}

/**
 * Test-only: restore the defaults and drop every recorded point. Declarations survive on purpose
 * — instruments are declared at module scope, and removing them would leave live references
 * writing into a registry nothing reads.
 */
export function resetMetrics(): void {
  exporter = noopMetricExporter;
  clock = systemClock;
  enabled = true;
  for (const instrument of instruments.values()) {
    instrument.series.clear();
    instrument.overflowed = false;
  }
}

/** Stable series key: attribute order must not create a second series for one label set. */
function seriesKey(attributes: MetricAttributes): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return '';
  return entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}\u0000${String(value)}`)
    .join('');
}

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new MetricValueInvalidError({
      cause: `${name} was given ${String(value)}, which is not a finite number`,
      fix: `guard the value at the call site: Number.isFinite(v) before recording into ${name}`,
      meta: { metric: name, received: String(value) },
    });
  }
  return value;
}

function declare(name: string, kind: MetricKind, options: GaugeOptions & HistogramOptions) {
  if (!METRIC_NAME_RE.test(name)) {
    throw new MetricNameInvalidError({
      cause: `"${name}" is not lowercase snake_case matching ${METRIC_NAME_RE.source}`,
      fix: `rename the instrument to lowercase snake_case, e.g. ${name.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_')}`,
      meta: { name },
    });
  }
  const existing = instruments.get(name);
  if (existing !== undefined) {
    if (existing.descriptor.kind !== kind) {
      throw new MetricNameInvalidError({
        cause: `"${name}" is already declared as a ${existing.descriptor.kind}, redeclared as a ${kind}`,
        fix: `rename one of the two instruments named "${name}" — one metric name, one kind`,
        meta: { name, declared: existing.descriptor.kind, requested: kind },
      });
    }
    return existing;
  }
  const maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
  if (!Number.isInteger(maxSeries) || maxSeries < 1) {
    throw new MetricCardinalityError({
      cause: `${name} declared maxSeries ${String(maxSeries)}, which is not a positive integer`,
      fix: `pass a positive integer: counter('${name}', { maxSeries: ${DEFAULT_MAX_SERIES} })`,
      meta: { metric: name, maxSeries: String(maxSeries) },
    });
  }
  const instrument: Instrument = {
    descriptor: {
      name,
      kind,
      unit: options.unit ?? '1',
      description: options.description ?? '',
    },
    series: new Map<string, Series>(),
    bounds: options.bounds ?? DEFAULT_HISTOGRAM_BOUNDS,
    observe: options.observe,
    maxSeries,
    overflowed: false,
  };
  instruments.set(name, instrument);
  return instrument;
}

/**
 * Reported through the logger rather than thrown: the call site is `orderCounter.add(1, …)` deep
 * inside a request, and killing that request would turn a metrics bug into a user-visible outage
 * — which is the same trade `finite()` does NOT make, because a NaN is a caller bug at one call
 * site while this is a design bug the whole instrument shares.
 */
function reportOverflow(instrument: Instrument): void {
  if (instrument.overflowed) return;
  instrument.overflowed = true;
  const { name, kind } = instrument.descriptor;
  const error = new MetricCardinalityError({
    cause: `${name} reached its ceiling of ${instrument.maxSeries} label set(s); every further label set folds into one ${OVERFLOW_ATTRIBUTE}="true" series`,
    fix: `drop the unbounded label from the ${name} call site (an id, a path, an email is never a label), or raise it deliberately: ${kind}('${name}', { maxSeries: ${instrument.maxSeries * 2} })`,
    meta: { metric: name, maxSeries: instrument.maxSeries },
  });
  logger.error(error.format(), { code: error.code, metric: name });
}

function createSeries(instrument: Instrument, key: string, attributes: MetricAttributes): Series {
  const created: Series = {
    attributes,
    value: 0,
    count: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    buckets: new Array<number>(instrument.bounds.length + 1).fill(0),
  };
  instrument.series.set(key, created);
  return created;
}

const OVERFLOW_KEY = seriesKey(OVERFLOW_ATTRIBUTES);

function seriesFor(instrument: Instrument, attributes: MetricAttributes): Series {
  const key = seriesKey(attributes);
  const found = instrument.series.get(key);
  if (found !== undefined) return found;
  if (instrument.series.size >= instrument.maxSeries) {
    reportOverflow(instrument);
    // Created directly rather than through this function again: the overflow series is the ONE
    // allocation the ceiling does not apply to, and routing it back through the check is an
    // infinite recursion the first time the cap is hit.
    return (
      instrument.series.get(OVERFLOW_KEY) ??
      createSeries(instrument, OVERFLOW_KEY, OVERFLOW_ATTRIBUTES)
    );
  }
  return createSeries(instrument, key, attributes);
}

/** Monotonic sum. A negative `add` is a bug in the caller, never a silent decrement. */
export function counter(name: string, options?: InstrumentOptions): Counter {
  const instrument = declare(name, 'counter', options ?? {});
  return {
    add(value = 1, attributes = {}): void {
      if (!enabled) return;
      if (finite(name, value) < 0) {
        throw new MetricValueInvalidError({
          cause: `counter ${name} was decremented by ${value}; counters only go up`,
          fix: `use gauge('${name}') for a value that can fall, or pass a non-negative delta`,
          meta: { metric: name, received: value },
        });
      }
      seriesFor(instrument, attributes).value += value;
    },
  };
}

export function gauge(name: string, options?: GaugeOptions): Gauge {
  const instrument = declare(name, 'gauge', options ?? {});
  return {
    record(value, attributes = {}): void {
      if (!enabled) return;
      seriesFor(instrument, attributes).value = finite(name, value);
    },
    add(delta, attributes = {}): void {
      if (!enabled) return;
      seriesFor(instrument, attributes).value += finite(name, delta);
    },
  };
}

export function histogram(name: string, options?: HistogramOptions): Histogram {
  const instrument = declare(name, 'histogram', options ?? {});
  return {
    record(value, attributes = {}): void {
      if (!enabled) return;
      const series = seriesFor(instrument, attributes);
      const observed = finite(name, value);
      series.value += observed;
      series.count += 1;
      series.min = Math.min(series.min, observed);
      series.max = Math.max(series.max, observed);
      const found = instrument.bounds.findIndex((bound) => observed <= bound);
      const bucket = found === -1 ? instrument.bounds.length : found;
      series.buckets[bucket] = (series.buckets[bucket] ?? 0) + 1;
    },
  };
}

function pointsOf(instrument: Instrument): readonly MetricPoint[] {
  if (instrument.observe !== undefined) {
    return [{ attributes: {}, value: instrument.observe() }];
  }
  return [...instrument.series.values()].map((series) =>
    instrument.descriptor.kind === 'histogram'
      ? {
          attributes: series.attributes,
          value: series.value,
          count: series.count,
          min: series.count === 0 ? 0 : series.min,
          max: series.count === 0 ? 0 : series.max,
          bounds: instrument.bounds,
          buckets: [...series.buckets],
        }
      : { attributes: series.attributes, value: series.value },
  );
}

/**
 * Cumulative temporality, as OTel defines it: totals since process start, never reset by a read.
 * A scrape that resets its own counters loses every sample between two scrapers.
 */
export function collectMetrics(): MetricCollection {
  return {
    at: clock.now().getTime(),
    resource: serviceResource(),
    metrics: [...instruments.values()]
      .map((instrument) => ({ descriptor: instrument.descriptor, points: pointsOf(instrument) }))
      .sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name)),
  };
}

/** One push tick. A driver decides when — `startMetricExport()` is the batteries-included when. */
export function exportMetrics(): void {
  if (!enabled) return;
  exporter.export(collectMetrics());
}

/**
 * Periodic push, returning the stop. Unref'd so an exporter never keeps a draining process alive
 * — the drain hook, not this timer, decides when the process may leave.
 */
export function startMetricExport(intervalMs = 60_000): () => void {
  const timer = setInterval(exportMetrics, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
