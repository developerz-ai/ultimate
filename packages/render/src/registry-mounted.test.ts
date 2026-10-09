// A route no surface file declares — mounted by a package, like the admin's screens — is in the
// ONE route list as what it is: `describePages()` carries it with who mounted it and what gates
// it, and `routeEntries()` — the pages the server renders from a file — does not, so nothing
// pretends a `page.tsx` exists. The filename rule for real files is untouched.

import { beforeEach, describe, expect, test } from 'bun:test';
import { RouteDuplicateError, RouteFileInvalidError } from './errors';
import {
  clearRoutes,
  describePages,
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
  test('describePages carries it, sorted with the file routes, naming its mount and permissions', () => {
    registerRoute({ file: 'apps/web/site/pricing/page.tsx', config: page });
    mount(['/admin', '/admin/posts', '/admin/posts/:id']);

    const described = describePages();
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
    expect(describePages()).toHaveLength(1);
  });

  test('a mount re-declared under its key REPLACES its routes — a save in x dev, not a duplicate', () => {
    mount(['/admin', '/admin/posts']);
    mount(['/admin', '/admin/users']);
    expect(describePages().map((route) => route.path)).toEqual(['/admin', '/admin/users']);
    // A second mount under another key is its own set.
    mount(['/back-office'], '/back-office');
    expect(describePages().map((route) => route.path)).toEqual([
      '/admin',
      '/admin/users',
      '/back-office',
    ]);
  });

  test('the description is rebuilt when a mount changes, and cleared with the table', () => {
    const before = describePages();
    mount(['/admin']);
    expect(describePages()).not.toBe(before);
    clearRoutes();
    expect(describePages()).toEqual([]);
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

describe('unit · a mount may let ONE app file claim one of its paths', () => {
  // The mounter's own answer: the config it issued for that path, by identity. Render never
  // decides who may claim — it asks the package that mounted the path.
  const issued = new Map<string, unknown>();
  const claimable = (path: string, config: unknown): boolean => issued.get(path) === config;
  const claiming = (paths: readonly string[]): void =>
    registerMountedRoutes(
      { ...MOUNT, claimable },
      paths.map((path) => ({ path, config: gated, permissions: ['admin:read', 'ops:read'] })),
    );
  const claim = defineRoute({
    render: 'ssr',
    offline: 'network-only',
    hydrate: 'never',
    policy: { permission: 'admin:read' },
    meta,
  });
  const FILE = 'apps/admin/app/admin/ops/page.tsx';

  beforeEach(() => {
    issued.clear();
    issued.set('/admin/ops', claim);
  });

  test('the issued config registers at the mounted path, in either order', () => {
    claiming(['/admin', '/admin/ops']);
    expect(() => registerRoute({ file: FILE, config: claim })).not.toThrow();

    clearRoutes();
    registerRoute({ file: FILE, config: claim });
    expect(() => claiming(['/admin', '/admin/ops'])).not.toThrow();
  });

  test('the claimed path is ONE row: the file, still carrying the mount and its permissions', () => {
    claiming(['/admin', '/admin/ops']);
    registerRoute({ file: FILE, config: claim });
    const rows = describePages().filter((route) => route.path === '/admin/ops');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file: FILE,
      mount: { by: 'defineAdmin', permissions: ['admin:read', 'ops:read'], claimed: true },
    });
    // An unclaimed mounted row says nothing about a claim.
    expect(describePages().find((route) => route.path === '/admin')?.mount).not.toHaveProperty(
      'claimed',
    );
  });

  test('refused: a config the mount did not issue — hand-written or a copy of the issued one', () => {
    claiming(['/admin/ops']);
    expect(() => registerRoute({ file: FILE, config: gated })).toThrow(RouteDuplicateError);
    const copy = defineRoute({ ...claim, meta });
    expect(() => registerRoute({ file: FILE, config: copy })).toThrow(RouteDuplicateError);

    clearRoutes();
    registerRoute({ file: FILE, config: gated });
    expect(() => claiming(['/admin/ops'])).toThrow(RouteDuplicateError);
  });

  test('refused: a config issued for one path, registered at another', () => {
    claiming(['/admin/ops', '/admin/billing']);
    expect(() =>
      registerRoute({ file: 'apps/admin/app/admin/billing/page.tsx', config: claim }),
    ).toThrow(RouteDuplicateError);
  });

  test('a mount that offers no claim refuses every file, as before', () => {
    mount(['/admin/ops']);
    expect(() => registerRoute({ file: FILE, config: claim })).toThrow(RouteDuplicateError);
  });
});
