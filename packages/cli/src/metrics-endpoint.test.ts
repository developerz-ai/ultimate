// A real socket, a real scrape. The whole point of this file is that `/metrics` answers with a
// body a Prometheus-compatible adapter can parse — asserting `metricsText()` alone would prove
// core works and leave the endpoint exactly as unmounted as it was.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  METRICS_CONTENT_TYPE,
  METRICS_PATH,
  recordConnection,
  recordQueueDepth,
  recordRequest,
  resetListeners,
  resetMetrics,
} from '@ultimat3/core';
import {
  type MetricsEndpoint,
  MetricsPortInUseError,
  startMetricsEndpoint,
} from './metrics-endpoint';

let endpoint: MetricsEndpoint | undefined;

beforeEach(() => {
  resetMetrics();
  // Ephemeral: a fixed 9090 here would fail on whichever machine already runs a Prometheus.
  endpoint = startMetricsEndpoint({ port: 0 });
});

afterEach(() => {
  endpoint?.stop();
  endpoint = undefined;
  resetListeners();
});

const scrape = async (path = METRICS_PATH): Promise<Response> =>
  await fetch(`${endpoint?.url ?? ''}${path}`);

describe('the scrape endpoint', () => {
  test('serves the three series the deploy chart names, under the exposition content type', async () => {
    recordRequest({ method: 'GET', route: '/posts/:id', status: 200, durationMs: 12 });
    recordConnection(1);
    recordQueueDepth('default', 41);

    const response = await scrape();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);

    const body = await response.text();
    // Verbatim, because `docker/helm/values.yaml` names `connections` and `queue_depth` verbatim
    // and derives `rps` from `http_requests_total`.
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('http_requests_total{method="GET",route="/posts/:id",status="2xx"} 1');
    expect(body).toContain('# TYPE connections gauge');
    expect(body).toContain('connections 1');
    expect(body).toContain('queue_depth{queue="default"} 41');
    expect(body).toContain('http_request_duration_seconds_count');
    // A rate is derived by the adapter, never stored: nothing may export a series called `rps`.
    expect(body).not.toContain('\nrps');
  });

  test('answers only its own path — it is not a second router', async () => {
    expect((await scrape('/')).status).toBe(404);
    expect((await scrape('/healthz')).status).toBe(404);
  });

  // The bug this guards: a second `x dev` died on `Bun.serve`'s own bare `Error` — no `X_*` code,
  // no `fix:` — at the FIRST thing `startRoles` opens, so the boot path this package owns handed
  // back a stack trace instead of an instruction.
  test('a port already bound is a coded refusal naming the port, never a bare Error', () => {
    const taken = Number(new URL(endpoint?.url ?? 'http://localhost:0').port);
    let caught: unknown;
    try {
      startMetricsEndpoint({ port: taken }).stop();
    } catch (error) {
      caught = error;
    }
    // `expect(fn).toThrow(Class)` passes in Bun 1.3.14 when the callee merely RETURNS an error, so
    // the identity is asserted off the caught value.
    expect(caught).toBeInstanceOf(MetricsPortInUseError);
    expect(caught).toMatchObject({ code: 'X_PORT_IN_USE' });
    expect((caught as { cause: string }).cause).toContain(String(taken));
    expect((caught as { fix: string }).fix).toContain('METRICS_PORT=');
  });

  test('a scrape does not reset the counters it read', async () => {
    recordRequest({ method: 'GET', route: '/public', status: 200, durationMs: 1 });
    await scrape();
    const second = await (await scrape()).text();

    // Cumulative temporality: two scrapers must not steal each other's samples.
    expect(second).toContain('http_requests_total{method="GET",route="/public",status="2xx"} 1');
  });
});
