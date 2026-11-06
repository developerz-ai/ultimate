// `/_client-vitals` through the real `httpPipeline`: a good beacon lands one histogram sample per
// timing, labelled by route PATTERN; an unknown name, an absurd value, an unmatched path and a
// cross-site beacon land nothing — and every one of them answers the same 204.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ClientVitalsConfig } from '@ultimat3/core';
import { collectMetrics, resetMetrics } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { compilePattern } from '@ultimat3/render';
import type { ClientErrorPage } from './client-errors-routes';
import { clientVitalsRoutes, clientVitalsSurface } from './client-vitals-route';
import {
  CLIENT_VITALS_PATH,
  CLIENT_VITALS_SCRIPT_PATH,
  clientVitalsScript,
} from './client-vitals-script';

const ON: ClientVitalsConfig = { enabled: true, sampleRate: 1, surfaces: ['app'] };

const PAGES: readonly ClientErrorPage[] = [
  { path: '/posts/:id', surface: 'app', pattern: compilePattern('/posts/:id'), islands: [] },
  { path: '/pricing', surface: 'site', pattern: compilePattern('/pricing'), islands: [] },
];

afterEach(() => resetMetrics());

function server(config: ClientVitalsConfig = ON) {
  const pipeline = httpPipeline({
    table: httpRouter(clientVitalsRoutes(config, { pages: () => PAGES })),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    hooks: { authenticate: () => null },
  });
  // `null` sends no browser evidence at all — the caller the pipeline's `csrf` stage lets through.
  return (body: unknown, site: string | null = 'same-origin'): Promise<Response> =>
    pipeline.handle(
      new Request(`http://app.test${CLIENT_VITALS_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          ...(site === null ? {} : { 'sec-fetch-site': site }),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { role: 'web', ip: '203.0.113.7' },
    );
}

/** Every recorded point of one instrument, as `{ labels, count, sum }`. */
const samples = (name: string) =>
  (collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ?? []).map(
    (point) => ({
      labels: point.attributes,
      count: 'count' in point ? point.count : 0,
      sum: point.value,
    }),
  );

describe('POST /_client-vitals', () => {
  test('a good beacon is one sample per timing, in seconds, under the route pattern', async () => {
    const response = await server()({
      path: '/posts/42',
      vitals: { lcp: 1200, fcp: 400, inp: 80, ttfb: 150, cls: 0.05 },
    });
    expect(response.status).toBe(204);
    const seconds = samples('web_vital_seconds');
    expect(seconds).toContainEqual({
      labels: { route: '/posts/:id', metric: 'lcp' },
      count: 1,
      sum: 1.2,
    });
    expect(seconds).toHaveLength(4);
    expect(samples('web_vital_cls')).toEqual([
      { labels: { route: '/posts/:id' }, count: 1, sum: 0.05 },
    ]);
  });

  test('an unknown name and an absurd value are dropped; the rest of the beacon lands', async () => {
    const response = await server()({
      path: '/posts/42',
      vitals: { lcp: 9_000_000, fid: 30, fcp: 300, cls: 400, inp: -5 },
    });
    expect(response.status).toBe(204);
    expect(samples('web_vital_seconds')).toEqual([
      { labels: { route: '/posts/:id', metric: 'fcp' }, count: 1, sum: 0.3 },
    ]);
    expect(samples('web_vital_cls')).toEqual([]);
  });

  test('a path no listed page matches lands nothing — the label set is the route table', async () => {
    const run = server();
    for (const path of ['/nowhere', '/pricing', 'https://evil.test/x?token=1', '/posts/1?q=a']) {
      expect((await run({ path, vitals: { lcp: 1000 } })).status).toBe(204);
    }
    expect(samples('web_vital_seconds')).toEqual([]);
  });

  test('site/ beacons land only when the surface is listed', async () => {
    const run = server({ ...ON, surfaces: ['app', 'site'] });
    await run({ path: '/pricing', vitals: { lcp: 500 } });
    expect(samples('web_vital_seconds')).toEqual([
      { labels: { route: '/pricing', metric: 'lcp' }, count: 1, sum: 0.5 },
    ]);
  });

  test('refused bodies are all the same 204, and land nothing', async () => {
    const run = server();
    for (const body of ['not json', '[]', { path: '/posts/1' }, { path: '/posts/1', vitals: 3 }]) {
      expect((await run(body)).status).toBe(204);
    }
    // A script with no browser evidence is not a page: the same 204, nothing recorded.
    expect((await run({ path: '/posts/1', vitals: { lcp: 900 } }, null)).status).toBe(204);
    // A cross-site page is the pipeline's own `csrf` refusal, before this handler runs.
    expect((await run({ path: '/posts/1', vitals: { lcp: 900 } }, 'cross-site')).status).toBe(403);
    expect(samples('web_vital_seconds')).toEqual([]);
  });

  test('a thousand distinct paths are still one series per route and metric', async () => {
    const run = server();
    for (let id = 0; id < 50; id += 1) await run({ path: `/posts/${id}`, vitals: { lcp: 1000 } });
    expect(samples('web_vital_seconds')).toEqual([
      { labels: { route: '/posts/:id', metric: 'lcp' }, count: 50, sum: 50 },
    ]);
  });
});

describe('the surface', () => {
  test('off mounts nothing and names no script', () => {
    expect(clientVitalsSurface({ ...ON, enabled: false })).toBeUndefined();
    expect(clientVitalsSurface(undefined)).toBeUndefined();
  });

  test('on: two routes, and a head for exactly the listed surfaces', () => {
    const app = clientVitalsSurface(ON);
    expect(app?.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${CLIENT_VITALS_SCRIPT_PATH}`,
      `POST ${CLIENT_VITALS_PATH}`,
    ]);
    expect(app?.appHead).toContain(CLIENT_VITALS_SCRIPT_PATH);
    expect(app?.siteHead).toBe('');
    expect(clientVitalsSurface({ ...ON, surfaces: ['site'] })?.siteHead).toContain(
      CLIENT_VITALS_SCRIPT_PATH,
    );
  });

  test('the script carries the sample rate and beacons on hide', () => {
    const script = clientVitalsScript(0.25);
    expect(script).toContain('Math.random()<0.25');
    expect(script).toContain('sendBeacon');
    expect(script).toContain('visibilitychange');
    expect(() => clientVitalsScript(Number.NaN)).toThrow();
  });
});
