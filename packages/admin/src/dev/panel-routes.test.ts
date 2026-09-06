// The routes panel answers "which handler serves this?", so the row order is the reading order —
// and an order that depends on the runtime's ICU default locale is a different table on the
// developer's machine than on the container the same build runs in.

import { describe, expect, test } from 'bun:test';
import { staticDevSources } from './data';
import type { RouteFact } from './facts';
import { routesPanel } from './panel-routes';

const route = (path: string, over: Partial<RouteFact> = {}): RouteFact => ({
  path,
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  handler: `apps/web/site${path}/page.tsx`,
  budget: {},
  revalidateTags: [],
  ...over,
});

const data = (routes: readonly RouteFact[]): ReturnType<typeof routesPanel.data> =>
  routesPanel.data(
    staticDevSources({ routes: () => Promise.resolve(routes) }),
    new URLSearchParams(),
  );

describe('the routes panel', () => {
  /**
   * `localeCompare` with no locale argument answers from the runtime's ICU default locale and its
   * collation version: it orders `_` before a digit and a lowercase letter before its uppercase
   * twin, where code units do neither. These four paths are the discriminating set — code units
   * give `/1 /A /_ /a`, the ICU default gives `/_ /1 /a /A`, so no two positions agree.
   */
  test('orders rows by code unit, so the table does not depend on the host locale', async () => {
    const panel = await data(['/a', '/_', '/A', '/1'].map((path) => route(path)));
    expect(panel.routes.map((row) => row.path)).toEqual(['/1', '/A', '/_', '/a']);
  });

  test('counts render modes and names only the routes over budget', async () => {
    const panel = await data([
      route('/', { render: 'static', budget: { js: '20kb' } }),
      route('/feed', { render: 'stream', budget: { js: '80kb' } }),
      route('/pricing', { render: 'static', budget: { js: '0.5mb' } }),
    ]);
    expect(panel.byRenderMode).toEqual({ static: 2, stream: 1 });
    expect(panel.overBudget).toEqual(['/feed', '/pricing']);
  });
});
