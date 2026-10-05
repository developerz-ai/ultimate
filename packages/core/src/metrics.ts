// Single responsibility: the OpenTelemetry-shaped metrics seam — counter, gauge and histogram
// aggregated in process, read through one `collectMetrics()`. Shaped exactly like `telemetry.ts`:
// always on, a no-op exporter by default, and the wire format supplied by a driver, never here.

import { assert } from './assert';
import { type Clock, systemClock } from './clock';
import { renderThrowable } from './error-render';
import { logger } from './logger';
import { finite, MetricValueInvalidError } from './metric-errors';
import { declare, type Instrument, instruments } from './metric-registry';
import { seriesFor } from './metric-series';
import type {
  Counter,
  Gauge,
  GaugeOptions,
  Histogram,
  HistogramOptions,
  InstrumentOptions,
  MetricCollection,
  MetricExporter,
  MetricPoint,
} from './metrics-types';
import { serviceResource } from './telemetry';

// The data model, the identifier grammar, the refusals, the registry and the series store are
// modules of their own; the public surface is unchanged, so nothing that imports a metric type, a
// constant or an error from here learns a second path.
export { MetricCardinalityError, MetricValueInvalidError } from './metric-errors';
export { MetricNameInvalidError } from './metric-names';
export { DEFAULT_HISTOGRAM_BOUNDS, DEFAULT_MAX_SERIES } from './metric-registry';
export { OVERFLOW_ATTRIBUTE } from './metric-series';
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
    // The screen runs BEFORE the series is resolved, as in `counter.add`: a refused value must
    // cost nothing, and `seriesFor` MINTS a series — bounded in number, kept for the process's
    // life, able to trip the cardinality ceiling. `a.b += finite(…)` evaluates the reference
    // first, so the two cannot be folded into one expression.
    record(value, attributes = {}): void {
      if (!enabled) return;
      const observed = finite(name, value);
      seriesFor(instrument, attributes).value = observed;
    },
    add(delta, attributes = {}): void {
      if (!enabled) return;
      const observed = finite(name, delta);
      seriesFor(instrument, attributes).value += observed;
    },
  };
}

export function histogram(name: string, options?: HistogramOptions): Histogram {
  const instrument = declare(name, 'histogram', options ?? {});
  return {
    record(value, attributes = {}): void {
      if (!enabled) return;
      // `finite` first, for `gauge`'s reason above.
      const observed = finite(name, value);
      const series = seriesFor(instrument, attributes);
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
  // Declared counter, no sample: 0, not absent (`rate()` needs a series) — until one exists.
  const unsampled =
    enabled && instrument.descriptor.kind === 'counter' && instrument.series.size === 0;
  if (unsampled) return [{ attributes: {}, value: 0 }];
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
