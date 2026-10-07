// The `/_x` jobs tab opens on a ring of the recent runs by state — ui's `DonutChart`, server
// markup with a hidden data table — over the same runs the `--json` payload lists, `?queue=` scope
// included. The admin's own overview follows it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { memoryJobDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { staticDevSources } from './data';
import type { JobRunFact } from './facts';
import { jobsPanel } from './panel-jobs';

// After `@ultimat3/render/server` has installed its `.tsx` loader, and never statically.
await import('@ultimat3/render/server');
const { jobsStateHtml } = await import('./jobs-state-chart');

const run = (id: string, status: JobRunFact['status'], queue = 'default'): JobRunFact => ({
  id,
  job: 'recount-likes',
  queue,
  status,
  attempt: 1,
  concurrencyKey: null,
  progress: null,
  steps: [],
});

const RUNS = [
  run('a', 'ok'),
  run('b', 'ok'),
  run('c', 'ok', 'mail'),
  run('d', 'failed'),
  run('e', 'dead', 'mail'),
];

const sources = staticDevSources({ jobRuns: () => Promise.resolve(RUNS) });

beforeAll(() => {
  setJobDriver(memoryJobDriver());
});

afterAll(() => {
  resetJobDriver();
});

describe('the jobs tab charts runs by state', () => {
  test('one segment per state that has runs, with its count in the fallback table', async () => {
    const data = await jobsPanel.data(sources, new URLSearchParams());
    const html = await jobsStateHtml(data);
    expect(html).toContain('Recent runs by state');
    // ok, failed, dead — `running` has none, so it is listed but draws no arc.
    expect(html.match(/data-segment="/g)).toHaveLength(3);
    expect(html).toMatch(/<th[^>]*>done<\/th>\s*<td[^>]*>3<\/td>/);
    expect(html).toMatch(/<th[^>]*>dead<\/th>\s*<td[^>]*>1<\/td>/);
    expect(html).not.toContain('<script');
  });

  test('a ?queue= filter scopes the ring as it scopes the runs', async () => {
    const data = await jobsPanel.data(sources, new URLSearchParams('queue=mail'));
    const html = await jobsStateHtml(data);
    expect(html).toMatch(/<th[^>]*>done<\/th>\s*<td[^>]*>1<\/td>/);
    expect(html).toMatch(/<th[^>]*>failed<\/th>\s*<td[^>]*>0<\/td>/);
  });

  test('no run yet draws no ring: an empty circle reads as a broken chart', async () => {
    const data = await jobsPanel.data(staticDevSources(), new URLSearchParams());
    expect(await jobsStateHtml(data)).toBe('');
  });

  test('the panel draws the ring above the admin overview', async () => {
    const params = new URLSearchParams();
    const data = await jobsPanel.data(sources, params);
    const html = (await jobsPanel.html?.(params, '/_x/jobs', data)) ?? '';
    const ring = html.indexOf('Recent runs by state');
    expect(ring).toBeGreaterThan(-1);
    expect(html.indexOf('data-stat="ready"')).toBeGreaterThan(ring);
  });
});
