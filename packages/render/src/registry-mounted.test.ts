// A route no surface file declares — mounted by a package, like the admin's screens — is in the
// ONE route list as what it is: `describeRoutes()` carries it with who mounted it and what gates
// it, and `routeEntries()` — the pages the server renders from a file — does not, so nothing
// pretends a `page.tsx` exists. The filename rule for real files is untouched.

import { beforeEach, describe, expect, test } from 'bun:test';
import { RouteDuplicateError, RouteFileInvalidError } from './errors';
import {
  clearRoutes,
  describeRoutes,
  registerMountedRoutes,
  registerRoute,
  routeEntries,
} from './registry';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const gated = defineRoute({
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'never',
  policy: { permission: 'admin:read' },
  meta,
});

const page = defineRoute({ render: 'static', offline: 'precache', hydrate: 'never', meta });

const MOUNT = {
  key: '/admin',
  by: 'defineAdmin',
  file: '@ultimat3/admin',
  surface: 'app',
} as const;

const mount = (paths: readonly string[], key: string = MOUNT.key): void =>
  registerMountedRoutes(
    { ...MOUNT, key },
    paths.map((path) => ({ path, config: gated, permissions: ['admin:read', 'posts:read'] })),
  );

beforeEach(() => {
  clearRoutes();
});

describe('unit · a mounted route is in the one route list', () => {
  test('describeRoutes carries it, sorted with the file routes, naming its mount and permissions', () => {
    registerRoute({ file: 'apps/web/site/pricing/page.tsx', config: page });
    mount(['/admin', '/admin/posts', '/admin/posts/:id']);

    const described = describeRoutes();
    expect(described.map((route) => route.path)).toEqual([
      '/admin',
      '/admin/posts',
      '/admin/posts/:id',
      '/pricing',
    ]);
    const row = described.find((route) => route.path === '/admin/posts/:id');
    expect(row).toMatchObject({
      file: '@ultimat3/admin',
      surface: 'app',
      mode: 'ssr',
      hydrate: 'never',
      offline: 'network-only',
      dynamic: true,
      hasPolicy: true,
      personal: true,
      islands: [],
      budgetJs: null,
      mount: { by: 'defineAdmin', permissions: ['admin:read', 'posts:read'] },
    });
    // A file route says nothing about a mount: the key is absent, not `null`.
    expect(described.find((route) => route.path === '/pricing')).not.toHaveProperty('mount');
    // JSON-safe, like every other row.
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });

  test('it is NOT a route entry: the server renders those from a file, and this one has none', () => {
    mount(['/admin']);
    expect(routeEntries()).toEqual([]);
    expect(describeRoutes()).toHaveLength(1);
  });

  test('a mount re-declared under its key REPLACES its routes — a save in x dev, not a duplicate', () => {
    mount(['/admin', '/admin/posts']);
    mount(['/admin', '/admin/users']);
    expect(describeRoutes().map((route) => route.path)).toEqual(['/admin', '/admin/users']);
    // A second mount under another key is its own set.
    mount(['/back-office'], '/back-office');
    expect(describeRoutes().map((route) => route.path)).toEqual([
      '/admin',
      '/admin/users',
      '/back-office',
    ]);
  });

  test('the description is rebuilt when a mount changes, and cleared with the table', () => {
    const before = describeRoutes();
    mount(['/admin']);
    expect(describeRoutes()).not.toBe(before);
    clearRoutes();
    expect(describeRoutes()).toEqual([]);
  });

  test('one URL, one claimant: a mount on a path a FILE already serves is refused, both ways', () => {
    registerRoute({ file: 'apps/web/app/admin/page.tsx', config: gated });
    expect(() => mount(['/admin'])).toThrow(RouteDuplicateError);
    expect(() => mount(['/admin'])).toThrow(/apps\/web\/app\/admin\/page\.tsx and defineAdmin/);

    clearRoutes();
    mount(['/admin']);
    expect(() => registerRoute({ file: 'apps/web/app/admin/page.tsx', config: gated })).toThrow(
      RouteDuplicateError,
    );
  });

  test('the filename rule for a real file is untouched', () => {
    expect(() => registerRoute({ file: 'apps/web/app/admin.tsx', config: gated })).toThrow(
      RouteFileInvalidError,
    );
  });
});
