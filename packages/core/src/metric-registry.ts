// Single responsibility: the instrument registry — one declaration per metric name, its shape
// refused at declaration (bounds, ceiling, a conflicting redeclaration) rather than at the first
// recording. `metric-series.ts` stores points under an instrument; `metrics.ts` is the public seam.

import { MetricCardinalityError } from './metric-errors';
import { assertMetricName, MetricNameInvalidError } from './metric-names';
import type {
  GaugeOptions,
  HistogramOptions,
  MetricAttributes,
  MetricDescriptor,
  MetricKind,
} from './metrics-types';

/**
 * The per-instrument series ceiling. 2000 is roomy for a bounded label set — every route pattern
 * times every status class times every method — and small enough that the process notices an
 * unbounded one long before the scrape body does.
 */
export const DEFAULT_MAX_SERIES = 2000;

/** OTel's default explicit bucket boundaries for a duration histogram, in seconds. */
export const DEFAULT_HISTOGRAM_BOUNDS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]);

export interface Series {
  readonly attributes: MetricAttributes;
  value: number;
  count: number;
  min: number;
  max: number;
  buckets: number[];
}

export interface Instrument {
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

export const instruments = new Map<string, Instrument>();

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

export function declare(
  name: string,
  kind: MetricKind,
  options: GaugeOptions & HistogramOptions,
): Instrument {
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
