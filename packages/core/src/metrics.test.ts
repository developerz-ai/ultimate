import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { isUltimateError, type UltimateError } from './errors';
import {
  collectMetrics,
  configureMetrics,
  counter,
  DEFAULT_MAX_SERIES,
  exportMetrics,
  gauge,
  type HistogramPoint,
  histogram,
  memoryMetricExporter,
  OVERFLOW_ATTRIBUTE,
  resetMetrics,
} from './metrics';

afterEach(() => {
  resetMetrics();
});

const pointsOf = (name: string) =>
  collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ?? [];

describe('counter', () => {
  test('sums per attribute set, independent of attribute order', () => {
    const served = counter('test_requests_total');
    served.add(1, { route: '/posts', method: 'GET' });
    served.add(2, { method: 'GET', route: '/posts' });
    served.add(1, { route: '/posts', method: 'POST' });

    const points = pointsOf('test_requests_total');
    expect(points).toHaveLength(2);
    expect(points.find((point) => point.attributes['method'] === 'GET')?.value).toBe(3);
  });

  test('refuses to go down — that is a gauge', () => {
    const served = counter('test_down_total');
    let caught: unknown;
    try {
      served.add(-1);
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    expect((caught as UltimateError).code).toBe('X_METRIC_VALUE_INVALID');
    expect((caught as UltimateError).fix).toContain("gauge('test_down_total')");
  });
});

describe('gauge', () => {
  test('records and moves, and an observed gauge is read at collection time', () => {
    const live = gauge('test_connections');
    live.add(1);
    live.add(1);
    live.add(-1);
    expect(pointsOf('test_connections')[0]?.value).toBe(1);

    let depth = 7;
    gauge('test_observed', { observe: () => depth });
    expect(pointsOf('test_observed')[0]?.value).toBe(7);
    depth = 9;
    expect(pointsOf('test_observed')[0]?.value).toBe(9);
  });
});

describe('histogram', () => {
  test('buckets, sums and counts every observation', () => {
    const duration = histogram('test_duration_seconds', { bounds: [0.1, 1] });
    duration.record(0.05);
    duration.record(0.5);
    duration.record(2);

    const point = pointsOf('test_duration_seconds')[0] as HistogramPoint;
    expect(point.count).toBe(3);
    expect(point.value).toBeCloseTo(2.55, 5);
    expect(point.min).toBe(0.05);
    expect(point.max).toBe(2);
    expect(point.buckets).toEqual([1, 1, 1]);
  });

  test('a non-finite observation is refused, never stored as NaN', () => {
    const duration = histogram('test_nan_seconds');
    expect(() => duration.record(Number.NaN)).toThrow('X_METRIC_VALUE_INVALID');
  });
});

describe('the instrument registry', () => {
  test('re-declaring the same name and kind returns the same instrument', () => {
    counter('test_shared_total').add(1);
    counter('test_shared_total').add(1);
    expect(pointsOf('test_shared_total')[0]?.value).toBe(2);
  });

  test('one name cannot be two kinds', () => {
    counter('test_conflict_total');
    let caught: unknown;
    try {
      gauge('test_conflict_total');
    } catch (thrown) {
      caught = thrown;
    }
    expect((caught as UltimateError).code).toBe('X_METRIC_NAME_INVALID');
  });

  test('a name no exposition format accepts is refused at declaration', () => {
    expect(() => counter('HTTP.Requests')).toThrow('X_METRIC_NAME_INVALID');
  });

  test('a second declaration stating different bounds is refused, not silently dropped', () => {
    // The first declaration won and the second's bounds were discarded without a word, so a
    // module recording into buckets it chose was reading another module's.
    histogram('test_redeclare_seconds', { bounds: [0.1, 1] });
    let caught: unknown;
    try {
      histogram('test_redeclare_seconds', { bounds: [1, 10] });
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    expect((caught as UltimateError).code).toBe('X_METRIC_NAME_INVALID');
    expect((caught as UltimateError).cause).toContain('0.1, 1');
  });

  test('a second declaration stating a different observer is refused', () => {
    gauge('test_redeclare_observed', { observe: () => 1 });
    let caught: unknown;
    try {
      gauge('test_redeclare_observed', { observe: () => 2 });
    } catch (thrown) {
      caught = thrown;
    }
    // Asserted before the cast: with nothing thrown, `caught` is `undefined` and reading `.code`
    // dies as a `TypeError` naming neither the metric nor the missing refusal.
    expect(isUltimateError(caught)).toBe(true);
    expect((caught as UltimateError).code).toBe('X_METRIC_NAME_INVALID');
    // The first observer is still the live one — the refusal changed nothing.
    expect(pointsOf('test_redeclare_observed')[0]?.value).toBe(1);
  });

  test('omitting an option takes a handle on the existing instrument, and never conflicts', () => {
    // `gauge(name)` is how a second module reads an instrument someone else declared; it states
    // nothing, so there is nothing to disagree about.
    const observed = () => 3;
    gauge('test_redeclare_handle', { observe: observed, maxSeries: 4 });
    expect(() => gauge('test_redeclare_handle')).not.toThrow();
    expect(() => gauge('test_redeclare_handle', { observe: observed })).not.toThrow();
    expect(() => histogram('test_redeclare_bounds')).not.toThrow();
    const bounds = [0.5, 5];
    histogram('test_redeclare_bounds_stated', { bounds });
    expect(() => histogram('test_redeclare_bounds_stated', { bounds: [0.5, 5] })).not.toThrow();
    expect(pointsOf('test_redeclare_handle')[0]?.value).toBe(3);
  });
});

describe('export', () => {
  test('is free until an exporter is configured, then pushes the whole collection', () => {
    counter('test_export_total').add(4);
    exportMetrics();

    const exporter = memoryMetricExporter();
    configureMetrics({ exporter, clock: frozenClock('2026-08-11T00:00:00.000Z') });
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

describe('cardinality ceiling', () => {
  test('an unbounded label does NOT create an unbounded number of series', () => {
    const orders = counter('test_cardinality_orders_total', { maxSeries: 3 });
    for (let index = 0; index < 500; index += 1) {
      orders.add(1, { orderId: `order-${index}` });
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
});
