import { describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import type { HistogramPoint, MetricCollection } from './metrics';
import { OTLP_ENDPOINT_KEY } from './otlp';
import { otlpMetricExporter, otlpMetricsRequest } from './otlp-metric-exporter';

const AT = 1_767_225_600_000;
const STARTED = 1_767_225_000_000;

const collection = (metrics: MetricCollection['metrics']): MetricCollection => ({
  at: AT,
  resource: { serviceName: 'web', serviceVersion: '1.2.0' },
  metrics,
});

const scopeMetrics = (request: unknown): Record<string, unknown>[] => {
  const typed = request as {
    resourceMetrics: { scopeMetrics: { metrics: Record<string, unknown>[] }[] }[];
  };
  return typed.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
};

describe('otlpMetricExporter', () => {
  test('refuses to exist with no endpoint, rather than exporting into nothing', () => {
    const previous = process.env[OTLP_ENDPOINT_KEY];
    delete process.env[OTLP_ENDPOINT_KEY];
    try {
      let code = 'no-throw';
      try {
        otlpMetricExporter();
      } catch (thrown) {
        code = isUltimateError(thrown) ? thrown.code : 'not-ultimate';
      }
      expect(code).toBe('X_OTLP_ENDPOINT_INVALID');
    } finally {
      if (previous !== undefined) process.env[OTLP_ENDPOINT_KEY] = previous;
    }
  });

  test('POSTs one snapshot per tick and never rejects at the caller', async () => {
    const bodies: string[] = [];
    const exporter = otlpMetricExporter({
      endpoint: 'http://collector:4318/v1/metrics',
      startedAtMs: STARTED,
      fetch: ((_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return Promise.resolve(new Response('', { status: 200 }));
      }) as unknown as typeof globalThis.fetch,
    });
    exporter.export(
      collection([
        {
          descriptor: { name: 'jobs_total', kind: 'counter', unit: '{job}', description: 'jobs' },
          points: [{ attributes: { queue: 'default' }, value: 3 }],
        },
      ]),
    );
    await exporter.flush();
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toHaveProperty('resourceMetrics');
  });

  test('a snapshot that cannot be serialised is dropped, and the next tick still exports', async () => {
    const bodies: string[] = [];
    const exporter = otlpMetricExporter({
      endpoint: 'http://collector:4318/v1/metrics',
      startedAtMs: STARTED,
      fetch: ((_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return Promise.resolve(new Response('', { status: 200 }));
      }) as unknown as typeof globalThis.fetch,
    });
    // `MetricAttributeValue` is a compile-time claim; a bigint reaches the serialiser at runtime.
    // `export` is called from a timer and awaited by nobody, so before the guard this TypeError
    // was thrown straight into the metric loop — telemetry ending the process it measures.
    const unspellable = 1n as unknown as string;
    expect(() =>
      exporter.export(
        collection([
          {
            descriptor: { name: 'bad_total', kind: 'counter', unit: '{x}', description: 'bad' },
            points: [{ attributes: { queue: unspellable }, value: 1 }],
          },
        ]),
      ),
    ).not.toThrow();
    await exporter.flush();
    expect(bodies).toHaveLength(0);

    exporter.export(
      collection([
        {
          descriptor: { name: 'after_total', kind: 'counter', unit: '{x}', description: 'after' },
          points: [{ attributes: {}, value: 2 }],
        },
      ]),
    );
    await exporter.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('after_total');
  });
});

describe('otlpMetricsRequest', () => {
  test('a counter is a monotonic CUMULATIVE sum — never a gauge', () => {
    const [metric] = scopeMetrics(
      otlpMetricsRequest(
        collection([
          {
            descriptor: { name: 'jobs_total', kind: 'counter', unit: '{job}', description: 'jobs' },
            points: [{ attributes: { queue: 'default' }, value: 3 }],
          },
        ]),
        STARTED,
      ),
    );
    expect(metric).toEqual({
      name: 'jobs_total',
      unit: '{job}',
      description: 'jobs',
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          {
            attributes: [{ key: 'queue', value: { stringValue: 'default' } }],
            startTimeUnixNano: '1767225000000000000',
            timeUnixNano: '1767225600000000000',
            asDouble: 3,
          },
        ],
      },
    });
  });

  test('a gauge carries no temporality — it is an instantaneous read', () => {
    const [metric] = scopeMetrics(
      otlpMetricsRequest(
        collection([
          {
            descriptor: { name: 'connections', kind: 'gauge', unit: '1', description: '' },
            points: [{ attributes: {}, value: 12 }],
          },
        ]),
        STARTED,
      ),
    );
    expect(metric).toHaveProperty('gauge');
    expect(metric).not.toHaveProperty('sum');
  });

  test('histogram bucket counts are strings, and min/max are omitted for an empty series', () => {
    // Declared as a `HistogramPoint` rather than inline: `ReadableMetric.points` is
    // `readonly MetricPoint[]`, so a fresh literal carrying the histogram half is an excess
    // property. Naming the type also checks the fixture against the contract the exporter reads.
    const empty: HistogramPoint = {
      attributes: {},
      value: 0,
      count: 0,
      min: 0,
      max: 0,
      bounds: [0.1, 1],
      buckets: [0, 0, 0],
    };
    const [metric] = scopeMetrics(
      otlpMetricsRequest(
        collection([
          {
            descriptor: { name: 'd_seconds', kind: 'histogram', unit: 's', description: '' },
            points: [empty],
          },
        ]),
        STARTED,
      ),
    );
    const point = (metric as { histogram: { dataPoints: Record<string, unknown>[] } }).histogram
      .dataPoints[0];
    expect(point?.['bucketCounts']).toEqual(['0', '0', '0']);
    expect(point?.['explicitBounds']).toEqual([0.1, 1]);
    expect(point).not.toHaveProperty('min');
  });
});

/** The same screen as the span exporter's, over the one bound this exporter carries. */
describe('otlpMetricExporter refuses a timeout that is not a timeout', () => {
  test('NaN, zero and a fraction are all refused at construction', () => {
    for (const timeoutMs of [Number.NaN, 0, 1.5, -1]) {
      expect(() => otlpMetricExporter({ endpoint: 'http://collector:4318', timeoutMs })).toThrow(
        /X_INVARIANT/,
      );
    }
  });
});
