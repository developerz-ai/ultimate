// `routeSnapshot()` / `restoreRoutes()`: the route table put back EXACTLY — file routes, their
// patterns, the configs a module exported and every mounted set — which `@ultimat3/testing`'s file
// boundary does, so one file's routes are no later file's `describePages()`.

import { afterAll, expect, test } from 'bun:test';
import {
  clearRoutes,
  describePages,
  registerMountedRoutes,
  registerRoute,
  restoreRoutes,
  routeEntries,
  routePatternOfFile,
  routeSnapshot,
} from './registry';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';

const inherited = routeSnapshot();
afterAll(() => restoreRoutes(inherited));

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const page = defineRoute({ render: 'static', offline: 'precache', hydrate: 'never', meta });
const gated = defineRoute({
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'never',
  policy: { permission: 'admin:read' },
  meta,
});
const MOUNT = { key: '/snap', by: 'defineAdmin', file: '@ultimat3/admin', surface: 'app' } as const;

test('a restore puts back exactly the snapshot, dropping what registered after it', () => {
  clearRoutes();
  registerRoute({ file: 'apps/web/site/kept/page.tsx', config: page });
  registerMountedRoutes(MOUNT, [{ path: '/snap/a', config: gated, permissions: ['admin:read'] }]);
  const snapshot = routeSnapshot();
  const described = describePages();

  registerRoute({ file: 'apps/web/site/late/page.tsx', config: page });
  registerMountedRoutes({ ...MOUNT, key: '/late' }, [
    { path: '/late/a', config: gated, permissions: ['admin:read'] },
  ]);
  restoreRoutes(snapshot);

  expect(describePages()).toEqual(described);
  expect(routeEntries().map((entry) => entry.path)).toEqual(['/kept']);
  expect(routePatternOfFile('apps/web/site/late/page.tsx')).toBeUndefined();
  expect(routePatternOfFile('apps/web/site/kept/page.tsx')).toBe('/kept');
  // The late path is free again: registering it is no duplicate.
  expect(() => registerRoute({ file: 'apps/web/site/late/page.tsx', config: page })).not.toThrow();
});
