// One URL, one gate. `adminRouteFor` is the lookup a host uses when it serves an admin URL from
// its own page file, and these assertions are what stop that host from typing the permission a
// second time — the shape the deployed demo shipped on five pages until 1.2.0.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { clearRoutes, describeRoutes, routeEntries } from '@ultimat3/render';
import type { AdminApp } from './admin';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import type { AdminCustomPage } from './pages';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically:
// `routes.ts` reaches the screens, and a static import compiles a `.tsx` before the plugin exists.
await import('@ultimat3/render/server');
const { adminRouteConfig, adminRouteFor, adminRouteMatch, adminRoutes } = await import('./routes');

const post = entity('admin_routes_post', {
  columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
});

// The route list is one per process and every admin mounts into it: a file that ran first left
// its own `/back-office` mount there, so this file reads the list from empty — and leaves it so.
clearRoutes();
afterAll(() => {
  clearRegistry();
  clearRoutes();
});

const auth = {
  actor: (): AdminActor | null => null,
  authz: staticAuthz(['admin:read', 'ops:read']),
};

const ops: AdminCustomPage = {
  path: '/ops',
  titleKey: 'admin.ops.title',
  permissions: ['ops:read'],
  component: () => 'ops-body',
};

let app: AdminApp;
beforeAll(() => {
  app = defineAdmin({
    entities: [post],
    db: database({ post }, { driver: memoryDriver() }),
    resources: { admin_routes_post: { path: '/posts' } },
    pages: [ops],
    auth,
  });
});

describe('adminRouteFor — the gate a mount reads instead of restating', () => {
  test('a generated view answers with the table’s own coarse permission', () => {
    const route = adminRouteFor(app, '/admin/posts');
    expect(route.permissions).toEqual(['admin:read', 'admin_routes_post:read']);
    expect(route.policy.permission).toBe('admin:read');
  });

  test('every admin document is noindex, nofollow — a list, a refusal and a 404 alike', async () => {
    for (const route of adminRoutes(app)) {
      // The admin's meta reads nothing off the context: a title key and the two directives.
      const context = { params: {}, url: `http://localhost${route.path}` };
      const meta = await route.config.meta(
        context as unknown as Parameters<typeof route.config.meta>[0],
      );
      expect({ path: route.path, robots: meta.robots }).toEqual({
        path: route.path,
        robots: { index: false, follow: false },
      });
    }
  });

  test('the lookup is a route of its resource, behind the same pair as its list', () => {
    const route = adminRouteFor(app, '/admin/posts/lookup');
    expect(route.view).toBe('lookup');
    expect(route.permissions).toEqual(['admin:read', 'admin_routes_post:read']);
    // A literal segment outranks `:id`: no row can be shadowed by it, and it shadows none.
    expect(adminRouteMatch(app, '/admin/posts/lookup')?.route.view).toBe('lookup');
  });

  test('defineAdmin puts its routes in the framework’s ONE route list — mounted, with their permissions', () => {
    const rows = describeRoutes().filter((route) => route.mount?.by === 'defineAdmin');
    // Every route of the table, and nothing a file would have declared.
    expect(rows.map((route) => route.path).sort()).toEqual(
      app.routes.map((route) => route.path).sort(),
    );
    const edit = rows.find((route) => route.path === '/admin/posts/:id/edit');
    expect(edit).toMatchObject({
      file: '@ultimat3/admin',
      surface: 'app',
      mode: 'ssr',
      hydrate: 'never',
      offline: 'network-only',
      hasPolicy: true,
      mount: { by: 'defineAdmin', permissions: ['admin:write', 'admin_routes_post:write'] },
    });
    // No page file is pretended: the server's own entries hold none of them.
    expect(routeEntries().filter((entry) => entry.path.startsWith('/admin'))).toEqual([]);
  });

  test('a jobs route answers the job pair, not an entity one', () => {
    expect(adminRouteFor(app, '/admin/jobs').permissions).toEqual(['admin:read', 'job:read']);
  });

  test('a custom page answers with its guarded screen', () => {
    const route = adminRouteFor(app, '/admin/ops');
    expect(typeof route.respond).toBe('function');
    expect(route.permissions).toEqual(['admin:read', 'ops:read']);
  });

  test('EVERY route has a screen — a generated view is never a path with nothing behind it', () => {
    for (const route of adminRoutes(app)) {
      expect({ path: route.path, screen: typeof route.respond }).toEqual({
        path: route.path,
        screen: 'function',
      });
    }
  });

  test('`policy` IS the object the route config carries — a mount cannot read a different gate', () => {
    const route = adminRouteFor(app, '/admin/posts');
    expect(route.config.policy).toBe(route.policy);
    // `permissions[0]` is the RECEIVED side: it is `string | undefined` under
    // `noUncheckedIndexedAccess`, and only the received side of `toBe` accepts that.
    expect(route.permissions[0]).toBe(route.policy.permission);
  });

  test('an undeclared path is refused, and the fix names the declaration that would fix it', () => {
    let code: string | undefined;
    let fix: string | undefined;
    try {
      adminRouteFor(app, '/admin/reconcile');
    } catch (error) {
      const thrown = error as { code?: string; fix?: string };
      code = thrown.code;
      fix = thrown.fix;
    }
    expect(code).toBe('X_ADMIN_PAGE_PATH_INVALID');
    expect(fix).toContain('pages:');
    // The paths that WOULD have worked, so the reader does not go looking for them.
    expect(fix).toContain('/admin/posts');
  });
});

describe('adminRouteConfig composes the gate exactly once', () => {
  test('every route in the table carries a policy identical to its first permission', () => {
    for (const route of app.routes) {
      const config = adminRouteConfig(app, route);
      expect(route.permissions[0]).toBe(config.policy.permission);
      expect(config.config.policy).toEqual(config.policy);
    }
  });
});

describe('adminRouteMatch — the route a request names', () => {
  test('a literal path matches itself, with no params', () => {
    const matched = adminRouteMatch(app, '/admin/posts');
    expect(matched?.route.view).toBe('list');
    expect(matched?.params).toEqual({});
  });

  test('a param is captured and percent-decoded', () => {
    const matched = adminRouteMatch(app, '/admin/posts/a%20b');
    expect(matched?.route.view).toBe('detail');
    expect(matched?.params).toEqual({ id: 'a b' });
  });

  test('the most SPECIFIC pattern wins: `new` is the create form, never a row called "new"', () => {
    expect(adminRouteMatch(app, '/admin/posts/new')?.route.view).toBe('create');
    expect(adminRouteMatch(app, '/admin/posts/p_1/edit')?.route.view).toBe('edit');
    expect(adminRouteMatch(app, '/admin/ops')?.route.view).toBe('page');
  });

  test('specificity decides, not table order: a page under a resource beats that resource’s :id', () => {
    // Pages are appended AFTER the generated routes, so a first-match walk would hand
    // `/admin/posts/archive` to the detail screen as a row called "archive".
    const withPage = defineAdmin({
      entities: [post],
      db: database({ post }, { driver: memoryDriver() }),
      resources: { admin_routes_post: { path: '/posts' } },
      pages: [{ ...ops, path: '/posts/archive' }],
      auth,
    });
    expect(adminRouteMatch(withPage, '/admin/posts/archive')?.route.view).toBe('page');
    expect(adminRouteMatch(withPage, '/admin/posts/p_1')?.route.view).toBe('detail');
  });

  test('a path nothing declares is null — the host answers 404, never a default screen', () => {
    expect(adminRouteMatch(app, '/admin/posts/p_1/edit/more')).toBeNull();
    expect(adminRouteMatch(app, '/elsewhere')).toBeNull();
  });
});

/**
 * `adminRouteFor` resolves by `.find()`, so two resources declaring one `path:` produced EIGHT
 * routes over FOUR paths and the second resource's four screens were unreachable — silently, at
 * boot, with the dashboard rendering. `admin.ts` already makes the identical argument for a
 * duplicate action NAME and refuses it there ("a call that succeeds against the wrong action and
 * reports nothing"), and `pages.ts` already refuses a page shadowing a generated route. A resource
 * path was the one claim on a URL that nothing checked.
 */
describe('two resources cannot claim one path', () => {
  const alt = entity('admin_routes_note', {
    columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
  });

  test('the second claim is refused at defineAdmin, naming both resources', () => {
    let thrown: unknown;
    try {
      defineAdmin({
        entities: [post, alt],
        db: database({ post, alt }, { driver: memoryDriver() }),
        resources: {
          admin_routes_post: { path: '/things' },
          admin_routes_note: { path: '/things' },
        },
        auth,
      });
    } catch (error) {
      thrown = error;
    }
    if (!isUltimateError(thrown)) expect.unreachable('expected defineAdmin to refuse');
    expect(thrown.code).toBe('X_ADMIN_PAGE_PATH_INVALID');
    expect(thrown.cause).toContain('/admin/things');
    // Both names, so one boot names the pair rather than half of it.
    expect(thrown.cause).toContain('admin_routes_post');
    expect(thrown.fix).toContain('path');
  });

  test('a page may still not shadow a generated resource route', () => {
    // The pre-existing half of the same rule, kept green: pages are checked against the paths the
    // resources claimed, and resources are now checked against each other first.
    expect(() =>
      defineAdmin({
        entities: [post],
        db: database({ post }, { driver: memoryDriver() }),
        resources: { admin_routes_post: { path: '/posts' } },
        pages: [{ ...ops, path: '/posts' }],
        auth,
      }),
    ).toThrow(expect.objectContaining({ code: 'X_ADMIN_PAGE_PATH_INVALID' }));
  });

  test('distinct paths still produce one route table with every screen', () => {
    const two = defineAdmin({
      entities: [post, alt],
      db: database({ post, alt }, { driver: memoryDriver() }),
      resources: {
        admin_routes_post: { path: '/posts' },
        admin_routes_note: { path: '/notes' },
      },
      auth,
    });
    const paths = two.routes.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('/admin/posts');
    expect(paths).toContain('/admin/notes');
  });
});
