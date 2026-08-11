import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { isUltimateError, type UltimateError } from './errors';
import {
  collectMetrics,
  configureMetrics,
  counter,
  exportMetrics,
  gauge,
  type HistogramPoint,
  histogram,
  memoryMetricExporter,
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
