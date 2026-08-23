import { afterEach, describe, expect, test } from 'bun:test';
import { counter, gauge, histogram, resetMetrics } from './metrics';
import { METRICS_CONTENT_TYPE, metricsText } from './metrics-text';
import { recordQueueDepth, recordRequest, SCALING_METRICS } from './runtime-metrics';

afterEach(() => {
  resetMetrics();
});

describe('metricsText', () => {
  test('renders HELP, TYPE and one line per series', () => {
    counter('text_requests_total', { description: 'requests served' }).add(3, { route: '/posts' });
    gauge('text_connections').record(12);

    const text = metricsText();
    expect(text).toContain('# HELP text_requests_total requests served');
    expect(text).toContain('# TYPE text_requests_total counter');
    expect(text).toContain('text_requests_total{route="/posts"} 3');
    expect(text).toContain('text_connections 12');
    expect(text).toContain('target_info{service_name="ultimate",service_version=');
  });

  test('a histogram renders cumulative buckets plus _sum and _count', () => {
    const duration = histogram('text_duration_seconds', { bounds: [0.1, 1] });
    duration.record(0.05);
    duration.record(0.5);
    duration.record(2);

    const lines = metricsText().split('\n');
    expect(lines).toContain('text_duration_seconds_bucket{le="0.1"} 1');
    expect(lines).toContain('text_duration_seconds_bucket{le="1"} 2');
    expect(lines).toContain('text_duration_seconds_bucket{le="+Inf"} 3');
    expect(lines).toContain('text_duration_seconds_count 3');
  });

  test('the le series ascends and its counts never go down', () => {
    // Prometheus and OpenMetrics both reject a non-monotonic `le` series, and a scrape that is
    // rejected is a metric that does not exist. The order comes from the declared bounds, which
    // is why `histogram()` refuses a set that is not strictly ascending.
    const latency = histogram('text_monotonic_seconds', { bounds: [0.5, 1, 5] });
    for (const observed of [0.4, 0.7, 3, 9]) latency.record(observed);

    const series = metricsText()
      .split('\n')
      .filter((line) => line.startsWith('text_monotonic_seconds_bucket'))
      .map((line) => {
        const [, le, count] = /le="([^"]+)"} (\d+)$/.exec(line) ?? [];
        return { le: Number(le === '+Inf' ? Number.POSITIVE_INFINITY : le), count: Number(count) };
      });

    expect(series.map((entry) => entry.le)).toEqual([0.5, 1, 5, Number.POSITIVE_INFINITY]);
    expect(series.map((entry) => entry.count)).toEqual([1, 2, 3, 4]);
    for (let index = 1; index < series.length; index += 1) {
      expect((series[index] as { le: number }).le).toBeGreaterThan(
        (series[index - 1] as { le: number }).le,
      );
      expect((series[index] as { count: number }).count).toBeGreaterThanOrEqual(
        (series[index - 1] as { count: number }).count,
      );
    }
  });

  test('escapes quotes, backslashes and newlines in label values', () => {
    counter('text_escapes_total').add(1, { route: 'a"b\\c\nd' });
    expect(metricsText()).toContain('text_escapes_total{route="a\\"b\\\\c\\nd"} 1');
  });

  test('serves as text/plain version 0.0.4 — what every scraper negotiates', () => {
    expect(METRICS_CONTENT_TYPE).toContain('text/plain');
  });
});

describe('the autoscaler contract', () => {
  test('the chart-facing series are named exactly as docker/helm scales on them', () => {
    recordRequest({ method: 'GET', route: '/posts/:id', status: 204, durationMs: 12 });
    recordQueueDepth('default', 41);

    const text = metricsText();
    // `connections` and `queue_depth` are the chart's own words; `rps` is a rate derived from
    // the counter, which is why the counter is what the process exposes.
    expect(SCALING_METRICS['ws-connections']).toBe('connections');
    expect(SCALING_METRICS['queue-depth']).toBe('queue_depth');
    expect(SCALING_METRICS.rps).toBe('http_requests_total');
    expect(text).toContain('queue_depth{queue="default"} 41');
    expect(text).toContain('# TYPE connections gauge');
    expect(text).toContain('# TYPE http_requests_total counter');
    // Status becomes a class, so one series does not become one per status code.
    expect(text).toContain('http_requests_total{method="GET",route="/posts/:id",status="2xx"} 1');
    expect(text).toContain('http_request_duration_seconds_count{method="GET"');
  });
});
