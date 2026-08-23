// One URL, one gate. `adminRouteFor` is the lookup a host uses when it serves an admin URL from
// its own page file, and these assertions are what stop that host from typing the permission a
// second time — the shape the deployed demo shipped on five pages until 1.2.0.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import type { AdminCustomPage } from './pages';
import { adminRouteConfig, adminRouteFor } from './routes';

const post = entity('admin_routes_post', {
  columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
});

afterAll(clearRegistry);

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

const app = defineAdmin({
  entities: [post],
  resources: { admin_routes_post: { path: '/posts' } },
  pages: [ops],
  auth,
});

describe('adminRouteFor — the gate a mount reads instead of restating', () => {
  test('a generated view answers with the table’s own coarse permission', () => {
    const route = adminRouteFor(app, '/admin/posts');
    expect(route.permissions).toEqual(['admin:read', 'admin_routes_post:read']);
    expect(route.policy.permission).toBe('admin:read');
  });

  test('a jobs route answers the job pair, not an entity one', () => {
    expect(adminRouteFor(app, '/admin/jobs').permissions).toEqual(['admin:read', 'job:read']);
  });

  test('a custom page answers with its guarded component', () => {
    const route = adminRouteFor(app, '/admin/ops');
    expect(route.component).not.toBeNull();
    expect(route.permissions).toEqual(['admin:read', 'ops:read']);
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
      const config = adminRouteConfig(route);
      expect(route.permissions[0]).toBe(config.policy.permission);
      expect(config.config.policy).toEqual(config.policy);
    }
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
        resources: { admin_routes_post: { path: '/posts' } },
        pages: [{ ...ops, path: '/posts' }],
        auth,
      }),
    ).toThrow(expect.objectContaining({ code: 'X_ADMIN_PAGE_PATH_INVALID' }));
  });

  test('distinct paths still produce one route table with every screen', () => {
    const two = defineAdmin({
      entities: [post, alt],
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
