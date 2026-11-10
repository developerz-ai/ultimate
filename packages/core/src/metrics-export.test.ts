// The metrics seam's outward half: the export tick on the instrumentation bus, the periodic push,
// and the cardinality ceiling that bounds what a tick carries. Instruments: `metrics.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { isUltimateError, type UltimateError } from './errors';
import { subscribe } from './instrument';
import {
  collectMetrics,
  configureMetrics,
  counter,
  DEFAULT_MAX_SERIES,
  exportMetrics,
  gauge,
  histogram,
  memoryMetricExporter,
  OVERFLOW_ATTRIBUTE,
  resetMetrics,
  startMetricExport,
} from './metrics';

afterEach(() => {
  resetMetrics();
});

const pointsOf = (name: string) =>
  collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ?? [];

describe('export', () => {
  // Metrics ride the instrumentation bus like spans and logs: an exporter is a `metric.export`
  // subscriber and its release is the unsubscribe — never a process-global slot to hand back.
  test('is free until something subscribes, then publishes the whole collection', () => {
    counter('test_export_total').add(4);
    const unheard = memoryMetricExporter();
    exportMetrics();
    expect(unheard.collections).toHaveLength(0);

    const exporter = memoryMetricExporter();
    configureMetrics({ clock: frozenClock('2026-08-11T00:00:00.000Z') });
    const release = subscribe('metric.export', (event) => exporter.export(event.payload));
    exportMetrics();
    release();
    exportMetrics();

    expect(exporter.collections).toHaveLength(1);
    const collection = exporter.collections[0];
    expect(collection?.at).toBe(Date.parse('2026-08-11T00:00:00.000Z'));
    expect(collection?.resource.serviceName).toBe('ultimate');
    expect(
      collection?.metrics.find((metric) => metric.descriptor.name === 'test_export_total')
        ?.points[0]?.value,
    ).toBe(4);
  });

  // 31.0.0: an exporter that drops every collection is "subscribe to nothing" — a second spelling
  // of the default. The bus being free until a subscriber arrives is the one way to export nothing.
  test('ships no no-op exporter: not subscribing is the way to export nothing', async () => {
    const surfaces = [
      await import('./metrics'),
      await import('./exports/observability'),
      await import('./index'),
    ];
    for (const surface of surfaces)
      expect(Object.keys(surface)).not.toContain('noopMetricExporter');
  });

  test('two exporters both hear one tick, and releasing one leaves the other', () => {
    const [a, b] = [memoryMetricExporter(), memoryMetricExporter()];
    const releaseA = subscribe('metric.export', (event) => a.export(event.payload));
    const releaseB = subscribe('metric.export', (event) => b.export(event.payload));
    exportMetrics();
    releaseA();
    exportMetrics();
    releaseB();
    expect([a.collections.length, b.collections.length]).toEqual([1, 2]);
  });

  test('a disabled process publishes nothing', () => {
    const exporter = memoryMetricExporter();
    const release = subscribe('metric.export', (event) => exporter.export(event.payload));
    configureMetrics({ enabled: false });
    exportMetrics();
    release();
    expect(exporter.collections).toHaveLength(0);
  });

  test('configureMetrics takes no exporter', () => {
    // @ts-expect-error — `exporter` left configureMetrics in 31.0.0: subscribe('metric.export', …).
    configureMetrics({ exporter: memoryMetricExporter() });
  });

  test('collection is cumulative — reading does not reset a counter', () => {
    counter('test_cumulative_total').add(1);
    collectMetrics();
    expect(pointsOf('test_cumulative_total')[0]?.value).toBe(1);
  });

  test('disabled instruments record nothing', () => {
    configureMetrics({ enabled: false });
    counter('test_disabled_total').add(5);
    expect(pointsOf('test_disabled_total')).toEqual([]);
  });
});

describe('startMetricExport', () => {
  /**
   * `setInterval(fn, NaN)` runs at 1ms in this Bun (measured, with a `TimeoutNaNWarning`), so an
   * interval of `Number(process.env.METRICS_INTERVAL_MS)` on an unset variable does not export
   * less often or more often by some wrong amount — it exports a thousand times a second, for the
   * life of the process, through whatever exporter is installed.
   */
  test('an interval that is not a number is refused, never a 1ms export loop', () => {
    expect(() => startMetricExport(Number.NaN)).toThrow(/X_INVARIANT/);
    expect(() => startMetricExport(0)).toThrow(/X_INVARIANT/);
    expect(() => startMetricExport(-1)).toThrow(/X_INVARIANT/);
  });

  test('an ordinary interval still starts and stops', () => {
    const stop = startMetricExport(60_000);
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('cardinality ceiling', () => {
  test('an unbounded label does NOT create an unbounded number of series', () => {
    const orders = counter('test_cardinality_orders_total', { maxSeries: 3 });
    for (let index = 0; index < 500; index += 1) {
      orders.add(1, { order_id: `order-${index}` });
    }
    const points = pointsOf('test_cardinality_orders_total');
    expect(points).toHaveLength(4);
    const overflow = points.find((point) => point.attributes[OVERFLOW_ATTRIBUTE] === true);
    expect(overflow?.value).toBe(497);
  });

  test('the label is Prometheus-safe — a `__`-prefixed one is stripped on scrape', () => {
    expect(OVERFLOW_ATTRIBUTE.startsWith('__')).toBe(false);
  });

  test('a series already known keeps counting past the ceiling', () => {
    const hits = counter('test_cardinality_hits_total', { maxSeries: 1 });
    hits.add(1, { route: '/a' });
    hits.add(1, { route: '/b' });
    hits.add(1, { route: '/a' });
    const points = pointsOf('test_cardinality_hits_total');
    expect(points.find((point) => point.attributes['route'] === '/a')?.value).toBe(2);
    expect(points.find((point) => point.attributes[OVERFLOW_ATTRIBUTE] === true)?.value).toBe(1);
  });

  test('gauges and histograms fold too', () => {
    const depth = gauge('test_cardinality_depth', { maxSeries: 1 });
    depth.record(5, { queue: 'a' });
    depth.record(9, { queue: 'b' });
    expect(pointsOf('test_cardinality_depth')).toHaveLength(2);

    const latency = histogram('test_cardinality_latency_seconds', { maxSeries: 1 });
    latency.record(0.1, { route: '/a' });
    latency.record(0.2, { route: '/b' });
    expect(pointsOf('test_cardinality_latency_seconds')).toHaveLength(2);
  });

  /**
   * A refused value must cost nothing. `counter.add` screens BEFORE it resolves the series;
   * `gauge.add`, `gauge.record` and `histogram.record` resolved it first, so a `NaN` from an app
   * minted a permanent series — one of a bounded number — and only then threw. Two instruments
   * apart in the same file, and the ceiling is exactly what an unbounded label is supposed to
   * spend, so a caller looping over ids with a broken value burned the budget while every write
   * was refused.
   */
  test('a refused value mints no series, on every instrument', () => {
    const depth = gauge('test_refused_depth', { maxSeries: 4 });
    depth.record(1, { queue: 'a' });
    expect(() => depth.add(Number.NaN, { queue: 'b' })).toThrow('X_METRIC_VALUE_INVALID');
    expect(() => depth.record(Number.NaN, { queue: 'c' })).toThrow('X_METRIC_VALUE_INVALID');
    expect(pointsOf('test_refused_depth')).toHaveLength(1);

    const spent = counter('test_refused_total', { maxSeries: 4 });
    spent.add(1, { route: '/a' });
    expect(() => spent.add(Number.NaN, { route: '/b' })).toThrow('X_METRIC_VALUE_INVALID');
    expect(pointsOf('test_refused_total')).toHaveLength(1);

    const latency = histogram('test_refused_seconds', { maxSeries: 4 });
    latency.record(0.1, { route: '/a' });
    expect(() => latency.record(Number.NaN, { route: '/b' })).toThrow('X_METRIC_VALUE_INVALID');
    expect(pointsOf('test_refused_seconds')).toHaveLength(1);
  });

  test('the default is generous enough that a bounded label set never trips it', () => {
    expect(DEFAULT_MAX_SERIES).toBeGreaterThanOrEqual(1000);
    const bounded = counter('test_cardinality_bounded_total');
    for (let index = 0; index < 200; index += 1) bounded.add(1, { route: `/r${index}` });
    expect(pointsOf('test_cardinality_bounded_total')).toHaveLength(200);
  });

  test('refuses a maxSeries that is not a positive integer', () => {
    let code = 'no-throw';
    try {
      counter('test_cardinality_bad_total', { maxSeries: 0 });
    } catch (thrown) {
      code = isUltimateError(thrown) ? (thrown as UltimateError).code : 'not-ultimate';
    }
    expect(code).toBe('X_METRIC_CARDINALITY');
  });

  /**
   * The label grammar must not be a function of how busy the process is. The screen ran inside
   * `createSeries`, and the overflow branch answers from the folded series WITHOUT allocating one
   * — so `bad"key` threw on a fresh process and was accepted in silence once the instrument was
   * full, which is the state a runaway label produces in the first place. Accepted means the point
   * lands on the overflow series and the caller is never told the label it passed is one no
   * scraper can parse.
   */
  test('a label past the ceiling is still refused — validation is not load-dependent', () => {
    const orders = counter('test_cardinality_late_label_total', { maxSeries: 2 });
    orders.add(1, { route: '/a' });
    orders.add(1, { route: '/b' });
    // Full: the next unknown label set folds rather than allocating.
    orders.add(1, { route: '/c' });
    expect(pointsOf('test_cardinality_late_label_total')).toHaveLength(3);

    let caught: unknown;
    try {
      orders.add(1, { 'bad"key': 'x' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    expect((caught as UltimateError).code).toBe('X_METRIC_NAME_INVALID');
    // And it was refused rather than folded: the overflow series did not take the point.
    const overflow = pointsOf('test_cardinality_late_label_total').find(
      (point) => point.attributes[OVERFLOW_ATTRIBUTE] === true,
    );
    expect(overflow?.value).toBe(1);
  });

  test('a known label set past the ceiling still needs no re-check, and keeps counting', () => {
    const hits = counter('test_cardinality_known_label_total', { maxSeries: 1 });
    hits.add(1, { route: '/a' });
    hits.add(1, { route: '/b' });
    hits.add(1, { route: '/a' });
    expect(
      pointsOf('test_cardinality_known_label_total').find(
        (point) => point.attributes['route'] === '/a',
      )?.value,
    ).toBe(2);
  });
});
