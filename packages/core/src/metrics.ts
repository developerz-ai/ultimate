// Single responsibility: the OpenTelemetry-shaped metrics seam — counter, gauge and histogram
// aggregated in process, read through one `collectMetrics()`. Shaped exactly like `telemetry.ts`:
// always on, a no-op exporter by default, and the wire format supplied by a driver, never here.

import { assert } from './assert';
import { type Clock, systemClock } from './clock';
import { renderThrowable } from './error-render';
import { type CodedErrorInit, UltimateError } from './errors';
import { logger } from './logger';
import { assertLabelNames, assertMetricName, MetricNameInvalidError } from './metric-names';
import type {
  Counter,
  Gauge,
  GaugeOptions,
  Histogram,
  HistogramOptions,
  InstrumentOptions,
  MetricAttributes,
  MetricCollection,
  MetricDescriptor,
  MetricExporter,
  MetricKind,
  MetricPoint,
} from './metrics-types';
import { serviceResource } from './telemetry';

// The data model and the identifier grammar are modules of their own; the public surface is
// unchanged, so nothing that imports a metric type or the name error from here learns a second
// path.
export { MetricNameInvalidError } from './metric-names';
export type {
  Counter,
  Gauge,
  GaugeOptions,
  Histogram,
  HistogramOptions,
  HistogramPoint,
  InstrumentOptions,
  MetricAttributes,
  MetricAttributeValue,
  MetricCollection,
  MetricDescriptor,
  MetricExporter,
  MetricKind,
  MetricPoint,
  ReadableMetric,
} from './metrics-types';

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
  /** Reported once, for the same reason: a scrape every 15s must not become a log every 15s. */
  observeFailed: boolean;
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
    instrument.observeFailed = false;
  }
}

/**
 * Stable series key: attribute order must not create a second series for one label set, and no
 * label set may spell another one's key.
 *
 * `JSON.stringify` over the sorted pairs, because a DELIMITER cannot carry the second property:
 * the key was the pairs joined by control characters (U+0000 inside a pair, U+0001 between them),
 * and a value holding those bytes IS another set's key — `{ a: 'b\u0001c\u0000d' }` was
 * `{ a: 'b', c: 'd' }`, so the point landed on whichever series arrived first and was exported
 * under labels the caller never passed. Attribute values are app data. Quoting is the only total
 * answer and is not slower: 644 ns/op against the join's 709, on a 3-label set. `String(value)`
 * stays, so `1` and `'1'` are still one series rather than two rows an exporter renders alike.
 */
function seriesKey(attributes: MetricAttributes): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return '';
  return JSON.stringify(
    entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => [key, String(value)]),
  );
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

/**
 * Bounds are strictly ascending finite numbers, refused at DECLARATION like `maxSeries` beside it.
 * `record` takes the first bound an observation fits, and the exposition format emits one
 * cumulative `le` series per bound in array order — so `[1, 0.5, 5]` both counted observations
 * into a bucket that was not theirs and rendered a non-monotonic `le` series that Prometheus and
 * OpenMetrics each reject. Two wrong numbers, neither visible from the other, and nothing at the
 * call site to notice: the observations themselves were all valid.
 */
function assertBounds(name: string, bounds: readonly number[] | undefined): void {
  if (bounds === undefined) return;
  const bad = bounds.findIndex((bound, index) => {
    const previous = index === 0 ? Number.NEGATIVE_INFINITY : (bounds[index - 1] as number);
    return !Number.isFinite(bound) || bound <= previous;
  });
  if (bad === -1) return;
  const repaired = [...new Set(bounds.filter((bound) => Number.isFinite(bound)))].sort(
    (left, right) => left - right,
  );
  throw new MetricNameInvalidError({
    cause: `${name} declared bounds [${bounds.map((bound) => String(bound)).join(', ')}], which are not strictly ascending finite numbers — [${String(bad)}] is ${String(bounds[bad])}`,
    fix: `sort the bounds and drop the duplicates: histogram('${name}', { bounds: [${repaired.join(', ')}] })`,
    meta: { metric: name, bounds: bounds.map((bound) => String(bound)), at: bad },
  });
}

function declare(name: string, kind: MetricKind, options: GaugeOptions & HistogramOptions) {
  assertMetricName(name);
  assertBounds(name, options.bounds);
  const existing = instruments.get(name);
  if (existing !== undefined) {
    if (existing.descriptor.kind !== kind) {
      throw new MetricNameInvalidError({
        cause: `"${name}" is already declared as a ${existing.descriptor.kind}, redeclared as a ${kind}`,
        fix: `rename one of the two instruments named "${name}" — one metric name, one kind`,
        meta: { name, declared: existing.descriptor.kind, requested: kind },
      });
    }
    assertSameDeclaration(name, existing, options);
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
    observeFailed: false,
  };
  instruments.set(name, instrument);
  return instrument;
}

/**
 * A second declaration that STATES a different shape is refused. The first declaration wins, so a
 * second `histogram(name, { bounds })` recorded into buckets another module chose and a second
 * `gauge(name, { observe })` was collected through the first module's observer — silently, in both
 * cases, which is the whole failure. An OMITTED option is not a conflict: `gauge(name)` is how a
 * module takes a handle on an instrument someone else declared, and `maxSeries` keeps its shipped
 * first-declaration-wins rule because it decides a ceiling rather than what gets recorded.
 */
function assertSameDeclaration(
  name: string,
  existing: Instrument,
  options: GaugeOptions & HistogramOptions,
): void {
  const { bounds, observe } = options;
  if (bounds !== undefined && !sameBounds(existing.bounds, bounds)) {
    throw new MetricNameInvalidError({
      cause: `"${name}" is already declared with bounds [${existing.bounds.join(', ')}] and is redeclared with [${bounds.join(', ')}]; the first declaration wins, so the second set would never be used`,
      fix: `declare "${name}" once and export the handle — import it where you record — or give the second instrument its own name`,
      meta: { name, declared: existing.bounds.join(','), requested: bounds.join(',') },
    });
  }
  if (observe !== undefined && observe !== existing.observe) {
    throw new MetricNameInvalidError({
      cause: `"${name}" is already declared with an observe() callback and is redeclared with a different one; the first declaration wins, so the second callback would never be read`,
      fix: `declare "${name}" once and export the handle — import it where you read — or give the second gauge its own name`,
      meta: { name },
    });
  }
}

const sameBounds = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((bound, index) => bound === right[index]);

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

/**
 * Reported through the logger for `reportOverflow`'s reason and once for the same one — a scrape
 * runs on a timer, so a permanently broken observer would otherwise write a log line every
 * interval forever. A recurrence after the first is therefore silent by design; the missing series
 * is the signal that outlives the line.
 */
function reportObserveFailure(instrument: Instrument, thrown: unknown): void {
  if (instrument.observeFailed) return;
  instrument.observeFailed = true;
  const { name, kind } = instrument.descriptor;
  const error = new MetricValueInvalidError({
    // `renderThrowable`, never `${thrown}`: the value is whatever the app's callback threw, and a
    // `.message` read on it is the one that throws where there is nothing left to answer with.
    cause: `the observe() callback of ${name} did not produce a value: ${renderThrowable(thrown)}; this instrument contributes no point until it does`,
    fix: `make the observe() callback of ${name} total — return a finite number when the resource it reads is gone, e.g. ${kind}('${name}', { observe: () => pool?.size ?? 0 })`,
    meta: { metric: name },
  });
  logger.error(error.format(), { code: error.code, metric: name });
}

function createSeries(instrument: Instrument, key: string, attributes: MetricAttributes): Series {
  assertLabelNames(instrument.descriptor.name, attributes);
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
  const observe = instrument.observe;
  if (observe !== undefined) {
    try {
      return [{ attributes: {}, value: finite(instrument.descriptor.name, observe()) }];
    } catch (thrown) {
      // The callback is the app's, run at SCRAPE time with no call site to blame: `() => pool.size`
      // after a drain throws, and an unguarded read here took every other instrument down with it
      // — /metrics 500s, `http_requests_total` goes invisible, and `startMetricExport`'s timer
      // callback raises where nothing can catch it. One hostile observer costs its own point only,
      // the same degradation `readinessChecks()` and the logger's per-key walk already make.
      reportObserveFailure(instrument, thrown);
      return [];
    }
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
  // A timer given a non-finite delay does not export less often — `setInterval(fn, NaN)` runs at
  // 1ms in this Bun, measured, so a `Number(process.env.METRICS_INTERVAL_MS)` on an unset variable
  // pushes a thousand collections a second for the life of the process.
  assert(
    Number.isSafeInteger(intervalMs) && intervalMs >= 1,
    `startMetricExport was given ${String(intervalMs)}ms; an export interval is a whole number of at least 1ms, and a timer given anything else runs at 1ms`,
    "pass a whole number of milliseconds — startMetricExport(60_000) — and parse an environment value first: Number(process.env.METRICS_INTERVAL_MS ?? '') is NaN when the variable is unset",
  );
  const timer = setInterval(exportMetrics, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
