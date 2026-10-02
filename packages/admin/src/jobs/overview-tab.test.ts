// `/_x`'s jobs tab and `/admin/jobs` are one component over one read: the tab is the admin's own
// overview, drawn over this process's queue, with the same tiles and the same chart.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resetJobDriver } from '@ultimat3/jobs';
import { ask, jobsAdmin, seedQueue } from './jobs-fixture';

const { jobsTabHtml } = await import('./overview-tab');
const { jobsPanel } = await import('../dev/panel-jobs');

beforeAll(async () => {
  await seedQueue();
});

afterAll(() => {
  resetJobDriver();
});

const stats = (html: string): readonly string[] =>
  [...html.matchAll(/data-stat="([^"]+)"/g)].map((match) => match[1] ?? '');

describe('the /_x jobs tab', () => {
  test('is the admin overview: the same tiles, the same chart, its range links on the tab', async () => {
    const tab = await jobsTabHtml('/_x/jobs', new URLSearchParams('range=7d'));
    const admin = await ask(jobsAdmin('/tab'), { id: 'u' }, '/tab/jobs?range=7d');
    expect(stats(tab)).toEqual(stats(admin.html));
    expect(stats(tab)).toContain('dead');
    expect(tab).toContain('href="/_x/jobs?range=1h"');
    expect(tab).toContain('aria-current="page"');
    expect(tab).not.toContain('<script');
  });

  test('an unknown range is the default one, and the panel draws through it', async () => {
    const tab = await jobsTabHtml('/_x/jobs', new URLSearchParams('range=forever'));
    expect(stats(tab)).toContain('ready');
    expect(await jobsPanel.html?.(new URLSearchParams(), '/_x/jobs')).toContain(
      'data-stat="ready"',
    );
  });
});
