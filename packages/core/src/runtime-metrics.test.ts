// Direct coverage: the runtime metrics every Ultimate process emits — `SCALING_METRICS` and the
// `record*` helpers layered on the module-level singleton instruments.

import { afterEach, describe, expect, test } from 'bun:test';
import { collectMetrics, type HistogramPoint, resetMetrics } from './metrics';
import {
  recordConnection,
  recordJob,
  recordLeaseLost,
  recordQueueDepth,
  recordRequest,
  SCALING_METRICS,
} from './runtime-metrics';

afterEach(() => {
  resetMetrics();
});

const pointsOf = (name: string) =>
  collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ?? [];

describe('SCALING_METRICS', () => {
  test('pins the table exactly — the seam shared with roles.ts and the deploy chart', () => {
    expect(SCALING_METRICS).toEqual({
      rps: 'http_requests_total',
      'ws-connections': 'connections',
      'queue-depth': 'queue_depth',
      singleton: null,
      'run-once': null,
      'per-database': null,
    });
  });
});

describe('recordRequest', () => {
  test('records a point with method/route verbatim and status floored to a class', () => {
    recordRequest({ method: 'GET', route: '/posts/:id', status: 200, durationMs: 12 });

    const points = pointsOf('http_requests_total');
    const point = points.find(
      (p) => p.attributes['method'] === 'GET' && p.attributes['route'] === '/posts/:id',
    );
    expect(point?.attributes['method']).toBe('GET');
    expect(point?.attributes['route']).toBe('/posts/:id');
    expect(point?.attributes['status']).toBe('2xx');
  });

  test.each([
    [100, '1xx'],
    [200, '2xx'],
    [301, '3xx'],
    [404, '4xx'],
    [500, '5xx'],
    [599, '5xx'],
  ])(
    'status %i floors to class %s, proving Math.floor(status/100), not a lookup table',
    (status, expected) => {
      recordRequest({ method: 'GET', route: `/status-${status}`, status, durationMs: 1 });
      const point = pointsOf('http_requests_total').find(
        (p) => p.attributes['route'] === `/status-${status}`,
      );
      expect(point?.attributes['status']).toBe(expected);
    },
  );

  test('requestDuration records durationMs converted to seconds, with method/route/status attributes and no durationMs field', () => {
    recordRequest({ method: 'POST', route: '/orders', status: 201, durationMs: 250 });

    const point = pointsOf('http_request_duration_seconds').find(
      (p) => p.attributes['route'] === '/orders',
    ) as HistogramPoint | undefined;
    expect(point).toBeDefined();
    expect(point?.attributes).toEqual({ method: 'POST', route: '/orders', status: '2xx' });
    expect(point?.attributes).not.toHaveProperty('durationMs');
    // A single observation: sum (value) equals the one converted sample, in seconds.
    expect(point?.value).toBeCloseTo(0.25, 5);
    expect(point?.min).toBeCloseTo(0.25, 5);
    expect(point?.max).toBeCloseTo(0.25, 5);
    expect(point?.count).toBe(1);
  });
});

describe('recordConnection', () => {
  test('the connections gauge moves by delta — a +1 then -1 nets to zero', () => {
    recordConnection(1);
    expect(pointsOf('connections')[0]?.value).toBe(1);
    recordConnection(-1);
    expect(pointsOf('connections')[0]?.value).toBe(0);
  });

  test('multiple connects accumulate before any disconnect', () => {
    recordConnection(1);
    recordConnection(1);
    recordConnection(1);
    expect(pointsOf('connections')[0]?.value).toBe(3);
  });
});

describe('recordQueueDepth', () => {
  test('records an ABSOLUTE depth with a {queue} attribute — the latest call wins, not a sum', () => {
    recordQueueDepth('emails', 10);
    expect(pointsOf('queue_depth').find((p) => p.attributes['queue'] === 'emails')?.value).toBe(10);

    recordQueueDepth('emails', 3);
    const points = pointsOf('queue_depth').filter((p) => p.attributes['queue'] === 'emails');
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(3);
  });

  test('different queues get independent series', () => {
    recordQueueDepth('emails', 5);
    recordQueueDepth('webhooks', 42);
    expect(pointsOf('queue_depth').find((p) => p.attributes['queue'] === 'emails')?.value).toBe(5);
    expect(pointsOf('queue_depth').find((p) => p.attributes['queue'] === 'webhooks')?.value).toBe(
      42,
    );
  });
});

describe('recordJob', () => {
  test('adds 1 to the jobs counter with {queue, outcome} for each outcome value', () => {
    recordJob('emails', 'ok');
    recordJob('emails', 'failed');
    recordJob('emails', 'dead');

    const points = pointsOf('jobs_total');
    expect(
      points.find((p) => p.attributes['queue'] === 'emails' && p.attributes['outcome'] === 'ok')
        ?.value,
    ).toBe(1);
    expect(
      points.find((p) => p.attributes['queue'] === 'emails' && p.attributes['outcome'] === 'failed')
        ?.value,
    ).toBe(1);
    expect(
      points.find((p) => p.attributes['queue'] === 'emails' && p.attributes['outcome'] === 'dead')
        ?.value,
    ).toBe(1);
  });

  test('repeated calls for the same queue/outcome accumulate', () => {
    recordJob('webhooks', 'ok');
    recordJob('webhooks', 'ok');
    const point = pointsOf('jobs_total').find(
      (p) => p.attributes['queue'] === 'webhooks' && p.attributes['outcome'] === 'ok',
    );
    expect(point?.value).toBe(2);
  });
});

describe('recordLeaseLost', () => {
  test('adds 1 to leasesLost with a {queue} attribute', () => {
    recordLeaseLost('emails');
    recordLeaseLost('emails');
    recordLeaseLost('webhooks');

    const points = pointsOf('job_leases_lost_total');
    expect(points.find((p) => p.attributes['queue'] === 'emails')?.value).toBe(2);
    expect(points.find((p) => p.attributes['queue'] === 'webhooks')?.value).toBe(1);
  });
});
