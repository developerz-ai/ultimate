// The supervisor's one port: the merged exposition (a `child` label, HELP/TYPE once per family),
// and the three answers over a real loopback socket with real child scrape listeners.

import { afterEach, describe, expect, test } from 'bun:test';
import { METRICS_PATH, markListening } from '@ultimat3/core';
import type { ChildView, SupervisorView } from './supervise';
import { childHealthy, labelSample, mergeMetrics, startSupervisorProbe } from './supervise-probe';

describe('unit · labelSample', () => {
  test.each([
    ['up 1', 'up{child="0"} 1'],
    ['up{} 1', 'up{child="0"} 1'],
    [
      'http_requests_total{route="/",status="200"} 4 1700000000',
      'http_requests_total{child="0",route="/",status="200"} 4 1700000000',
    ],
  ])('%p → %p', (line, labelled) => {
    expect(labelSample(line, 0)).toBe(labelled);
  });
});

describe('unit · mergeMetrics', () => {
  const child = (requests: number, help = 'Requests served.'): string =>
    [
      `# HELP http_requests_total ${help}`,
      '# TYPE http_requests_total counter',
      `http_requests_total{route="/"} ${String(requests)}`,
      '# HELP latency_seconds Latency.',
      '# TYPE latency_seconds histogram',
      'latency_seconds_bucket{le="0.1"} 1',
      'latency_seconds_sum 0.05',
      'latency_seconds_count 1',
      '',
    ].join('\n');

  test('one HELP and TYPE per family, then every child sample under it, child order', () => {
    expect(
      mergeMetrics([
        { index: 0, body: child(3) },
        { index: 1, body: child(5, 'Another wording.') },
      ]),
    ).toBe(
      [
        '# HELP http_requests_total Requests served.',
        '# TYPE http_requests_total counter',
        'http_requests_total{child="0",route="/"} 3',
        'http_requests_total{child="1",route="/"} 5',
        '# HELP latency_seconds Latency.',
        '# TYPE latency_seconds histogram',
        'latency_seconds_bucket{child="0",le="0.1"} 1',
        'latency_seconds_sum{child="0"} 0.05',
        'latency_seconds_count{child="0"} 1',
        'latency_seconds_bucket{child="1",le="0.1"} 1',
        'latency_seconds_sum{child="1"} 0.05',
        'latency_seconds_count{child="1"} 1',
        '',
      ].join('\n'),
    );
  });

  test('no child answered is an empty body', () => {
    expect(mergeMetrics([])).toBe('');
  });
});

describe('unit · startSupervisorProbe', () => {
  const opened: { stop(): void }[] = [];
  afterEach(() => {
    for (const one of opened.splice(0)) one.stop();
  });

  const childServer = (status: number, body: string) => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) =>
        new URL(request.url).pathname === METRICS_PATH
          ? new Response(body)
          : new Response('', { status }),
    });
    // Announced as every framework listener is, so the test network seal lets the scrape through.
    const unmark = markListening(server.url.origin);
    opened.push({
      stop: () => {
        server.stop(true);
        unmark();
      },
    });
    return server.url.origin;
  };

  function probe(view: Partial<SupervisorView>) {
    const started = startSupervisorProbe({
      port: 0,
      hostname: '127.0.0.1',
      role: 'web',
      view: { children: () => [], ready: () => false, live: () => true, ...view },
    });
    opened.push(started);
    return started.url;
  }

  test('/healthz is the supervisor, /readyz every child', async () => {
    let ready = false;
    let live = true;
    const url = probe({ ready: () => ready, live: () => live });
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    ready = true;
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    live = false;
    expect(await (await fetch(`${url}/healthz`)).json()).toMatchObject({ state: 'crash-loop' });
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  test('/metrics merges the children that answered', async () => {
    const children: ChildView[] = [
      { index: 0, state: 'ready', metricsUrl: childServer(200, 'up 1\n') },
      { index: 1, state: 'waiting', metricsUrl: undefined },
      { index: 2, state: 'ready', metricsUrl: childServer(200, 'up 1\n') },
    ];
    const url = probe({ children: () => children });
    const response = await fetch(`${url}${METRICS_PATH}`);
    expect(await response.text()).toBe('up{child="0"} 1\nup{child="2"} 1\n');
  });

  test('childHealthy is a 200 and nothing else', async () => {
    expect(await childHealthy(childServer(200, ''))).toBe(true);
    expect(await childHealthy(childServer(503, ''))).toBe(false);
    expect(await childHealthy('http://127.0.0.1:1')).toBe(false);
  });
});
