// /runs/health, rendered as a member with its two reads answered here: every chart-kit piece is
// in the page, named in the request's locale, and no label is a missing key; the window picker's
// URL reaches the read as `since`/`until`.
import { useT } from '@postly/i18n';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import { DEFAULT_DEMO_MEMBER, demoActorFor } from '../../auth/demo-actor';
import * as page from './page';

const SITE = '00000000-0000-4000-8000-0000000000d1';
const run = (id: string, status: 'done' | 'failed' | 'running', minute: number) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  connectionId: SITE,
  status,
  startedAt: new Date(Date.UTC(2026, 10, 6, 9, minute)),
  eventCount: minute,
});

const DATA: page.RunHealthData = {
  runs: [run('3', 'failed', 30), run('2', 'running', 9), run('1', 'done', 1)],
  connections: [{ id: SITE, label: 'Ledger' }],
  url: 'https://example.test/runs/health',
  now: '2026-11-06T12:00:00.000Z',
};

const routeWith = (data: page.RunHealthData) => ({
  ...page,
  config: { ...page.config, load: () => Promise.resolve(data) },
});

const request = {
  url: 'https://example.test/runs/health',
  actor: demoActorFor(DEFAULT_DEMO_MEMBER),
};

unitTest(
  'the page draws the strip, the trend, the gauge, the tiles and the indicator',
  async () => {
    const t = useT();
    const view = await renderRoute(routeWith(DATA), request);
    expect(view.html.match(/<h1\b/g)).toHaveLength(1);
    expect(view.text).toContain(t('app.runs.health.heading'));
    expect(view.html).not.toContain('⟦');
    // One cell per run, each named by its connection and its whole reading.
    expect(view.html.match(/role="img" aria-label="Ledger, /g)).toHaveLength(3);
    expect(view.html).toContain('data-live="paused"');
    expect(view.html).toContain('role="meter"');
    expect(view.html).toContain('data-stat="runs-failed"');
  },
);

unitTest('no ended run: the gauge reads no data, never 0%', async () => {
  const view = await renderRoute(routeWith({ ...DATA, runs: [run('2', 'running', 9)] }), request);
  expect(view.html).toContain('aria-valuetext="No data"');
});

unitTest('the window picker offers the three presets, the default week current', async () => {
  const t = useT();
  const view = await renderRoute(routeWith(DATA), request);
  expect(view.html).toContain(`aria-label="${t('app.runs.health.range.label')}"`);
  expect(view.html).toContain('href="/runs/health?range=day"');
  expect(view.html).toContain('href="/runs/health?range=month"');
  expect(view.html).toMatch(/href="\/runs\/health" aria-current="true"/);
  expect(view.text).toContain(t('app.runs.health.range.week'));
});

unitTest('load reads the runs of the window the URL names, in the member’s zone', async () => {
  const actor = demoActorFor(DEFAULT_DEMO_MEMBER);
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  const realUrl = process.env['APP_URL'];
  process.env['APP_URL'] = 'http://app.test';
  globalThis.fetch = ((url: string | URL | Request) => {
    seen.push(String(url));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  // A custom window, wall-clock in the member's zone (New York, UTC−5 in November).
  const asked = 'https://example.test/runs/health?from=2026-11-02T09:00&to=2026-11-03T09:00';
  try {
    await runWithContext({ ...ctxOf({ actor }), requestHeaders: new Headers() }, () =>
      renderRoute(page, { url: asked }),
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env['APP_URL'];
    else process.env['APP_URL'] = realUrl;
  }
  const health = new URL(seen.find((url) => url.includes('/_x/query/run-health')) ?? '');
  expect(health.searchParams.get('since')).toBe('2026-11-02T14:00:00.000Z');
  expect(health.searchParams.get('until')).toBe('2026-11-03T14:00:00.000Z');
});
