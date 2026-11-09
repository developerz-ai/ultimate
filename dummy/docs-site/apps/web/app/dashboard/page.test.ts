// The dashboard, rendered as a request renders it. Its facts are the framework's registries, so
// the test registers the one route it renders — the boot scan's job in a running app — and reads
// the tiles and the route table back off the markup.
import { catalogs, useT } from '@docs-site/i18n';
import { frameworkVersion } from '@ultimat3/core';
import { clearRoutes, registerRoute } from '@ultimat3/render';
import { afterAll, beforeAll, expect, renderRoute, unitTest } from '@ultimat3/testing';
import { roles } from '../../shared/roles';
import * as page from './page';

const url = 'https://example.test/dashboard';

/** The figure a tile shows, read off the markup by the `stat` the page gave it. */
const stat = (html: string, name: string): string | undefined =>
  html.match(new RegExp(`data-stat="${name}">([^<]*)<`))?.[1];

// The route table is process-global and a test process starts with none: this file registers the
// page it renders, and takes it back out so no later file inherits a route it never declared.
beforeAll(() => {
  registerRoute({ file: 'apps/web/app/dashboard/page.tsx', config: page.config });
});
afterAll(clearRoutes);

unitTest('the dashboard is gated, renders per request, and hydrates one island', async () => {
  const view = await renderRoute(page, { url });
  expect(page.config.render).toBe('stream');
  expect(page.config.policy?.permission).toBe('dashboard:read');
  expect(page.config.offline).toBe('runtime');
  expect(page.config.budget.js).toBe('60kb');
  // What the render emitted, beside what the config declares: the theme toggle, and only it.
  expect(view.islands.map((island) => [island.moduleId, island.strategy])).toEqual([
    ['shared-theme-toggle', 'visible'],
  ]);
});

unitTest('the tiles are the framework registries, counted', async () => {
  const view = await renderRoute(page, { url });
  expect(stat(view.html, 'routes')).toBe('1');
  expect(stat(view.html, 'locales')).toBe(String(catalogs.locales.length));
  expect(stat(view.html, 'roles')).toBe(String(Object.keys(roles).length));
  expect(stat(view.html, 'version')).toBe(frameworkVersion());
});

unitTest('the table is the route table: path, surface and render mode per route', async () => {
  const t = useT();
  const view = await renderRoute(page, { url });
  expect(view.html.match(/<tr[^>]*\sdata-row=/g)).toHaveLength(1);
  // Each cell ends in its value; on a phone a card label rides in front of it, hidden from AT.
  const row = view.html.match(/<tr[^>]*data-row="\/dashboard">([\s\S]*?)<\/tr>/)?.[1] ?? '';
  expect([...row.matchAll(/([^>]*)<\/td>/g)].map((cell) => cell[1])).toEqual([
    '/dashboard',
    'app',
    'stream',
  ]);
  expect(view.text).toContain(t('app.dashboard.routesCaption'));
  expect(view.meta.title).toBe(t('app.dashboard.title'));
  // The sidebar knows where it is.
  expect(view.html).toMatch(/<a href="\/dashboard" aria-current="page"/);
});
