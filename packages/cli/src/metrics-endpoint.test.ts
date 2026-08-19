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
import { PORT_RANGE } from './flag-number';
import {
  isAddressInUse,
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
  //
  // Asserted on the MAPPING, not on a second `Bun.serve`: whether the kernel refuses a rebind of a
  // live port is the OS's business and it does not answer the same way everywhere — this test bound
  // the port twice and passed locally while GitHub's runner allowed the second bind, so it failed
  // for a reason that was never this package's contract. What is ours is that an EADDRINUSE-shaped
  // throw becomes a coded refusal naming the port, and that is decidable without racing a socket.
  test('an EADDRINUSE-shaped throw is recognised, and nothing else is', () => {
    const bind = Object.assign(new Error('Failed to start server'), { code: 'EADDRINUSE' });
    expect(isAddressInUse(bind)).toBe(true);

    expect(isAddressInUse(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false);
    expect(isAddressInUse(new Error('no code at all'))).toBe(false);
    expect(isAddressInUse(undefined)).toBe(false);

    // A bind failure that crossed a worker or a subprocess arrives as a plain object carrying the
    // libc code — structurally the same fault, and `error instanceof Error` answers false for it.
    expect(isAddressInUse({ message: 'Failed to start server', code: 'EADDRINUSE' })).toBe(true);

    // And a value that fights being read answers false rather than throwing out of the guard:
    // `getPrototypeOf` is what `instanceof` runs, so a trap there took the old check with it.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new TypeError('trapped getPrototypeOf');
        },
        get() {
          throw new TypeError('trapped get');
        },
      },
    );
    expect(isAddressInUse(hostile)).toBe(false);
  });

  test('the refusal names the port and the knob that moves it', () => {
    const taken = Number(new URL(endpoint?.url ?? 'http://localhost:0').port);
    expect(taken).toBeGreaterThan(0);

    const refusal = new MetricsPortInUseError({ port: taken });
    expect(refusal).toBeInstanceOf(MetricsPortInUseError);
    expect(refusal).toMatchObject({ code: 'X_PORT_IN_USE' });
    expect(refusal.cause).toContain(String(taken));
    // `METRICS_PORT` is the one knob both `x dev` and the container read, so the fix has to name it.
    expect(refusal.fix).toContain('METRICS_PORT=');
    expect(refusal.fix).toContain(String(taken + 1));
  });

  // The same defect `x doctor` shipped and this release closed one file over: `port + 1` at the
  // top of the range names 65536, which is not a port — so the one instruction the reader is
  // given fails. The neighbour below is a port; the one above does not exist.
  test('the port the fix names is one that exists, at the top of the range too', () => {
    expect(new MetricsPortInUseError({ port: 3000 }).fix).toContain('METRICS_PORT=3001 ');
    const top = new MetricsPortInUseError({ port: PORT_RANGE.max });
    expect(top.fix).toContain(`METRICS_PORT=${PORT_RANGE.max - 1} `);
    expect(top.fix).not.toContain(String(PORT_RANGE.max + 1));
  });

  test('a scrape does not reset the counters it read', async () => {
    recordRequest({ method: 'GET', route: '/public', status: 200, durationMs: 1 });
    await scrape();
    const second = await (await scrape()).text();

    // Cumulative temporality: two scrapers must not steal each other's samples.
    expect(second).toContain('http_requests_total{method="GET",route="/public",status="2xx"} 1');
  });
});
