// The specification for a custom admin page: it is reachable, it is in the nav, and it CANNOT
// be mounted without its guard. Every assertion here failed before `pages.ts` existed — the
// route table had no slot for a page, and `adminRoutes()` threw on the first route it built.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import type { AdminCustomPage } from './pages';
import { adminRoutes } from './routes';

const post = entity('admin_page_post', {
  columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
});

afterAll(clearRegistry);

const auth = {
  actor: (): AdminActor | null => null,
  authz: staticAuthz(['admin:read', 'ops:read']),
};

/** The reconciliation-fixer shape: a page no generator would write, over no single entity. */
const ops: AdminCustomPage = {
  path: '/ops',
  titleKey: 'admin.ops.title',
  navGroup: 'admin.group.operations',
  permissions: ['ops:read'],
  component: () => 'ops-body',
};

const app = defineAdmin({
  entities: [post],
  resources: { admin_page_post: { path: '/posts' } },
  pages: [ops],
  auth,
});

const ctxFor = (granted: readonly string[]): CrudCtx =>
  defineAdmin({ entities: [], pages: [ops], auth: { ...auth, authz: staticAuthz(granted) } }).ctx({
    actor: { id: 'operator', roles: [] },
    requestId: 'test',
  });

describe('a custom page is a first-class route', () => {
  test('it lands in the route table under the base path', () => {
    const route = app.routes.find((candidate) => candidate.path === '/admin/ops');
    expect(route).toBeDefined();
    expect(route?.view).toBe('page');
    expect(route?.titleKey).toBe('admin.ops.title');
  });

  test('the frame permission is composed in front of the declared one', () => {
    const route = app.routes.find((candidate) => candidate.path === '/admin/ops');
    expect(route?.permissions).toEqual(['admin:read', 'ops:read']);
  });

  test('it is in the nav, in its declared group', () => {
    const group = app.nav.find((candidate) => candidate.key === 'admin.group.operations');
    expect(group?.items.map((item) => item.href)).toEqual(['/ops']);
  });

  test('the nav drops it for an actor who may not open it', () => {
    const visible = app.navFor(ctxFor(['admin:read', 'ops:read'])).map((group) => group.key);
    expect(visible).toContain('admin.group.operations');

    const denied = app.navFor(ctxFor(['admin:read'])).map((group) => group.key);
    expect(denied).not.toContain('admin.group.operations');
  });
});

describe('the guard cannot be omitted', () => {
  test('every emitted route config carries a policy', () => {
    const configs = adminRoutes(app);
    expect(configs.length).toBeGreaterThan(0);
    for (const emitted of configs) {
      expect(emitted.config.policy?.permission).toBe(emitted.permissions[0] ?? '');
    }
  });

  test('the route table exposes the guarded component, never the raw one', async () => {
    const emitted = adminRoutes(app).find((candidate) => candidate.path === '/admin/ops');
    expect(emitted?.component).toBeDefined();
    expect(emitted?.component).not.toBe(ops.component);

    const allowed = await emitted?.component?.({
      ctx: ctxFor(['admin:read', 'ops:read']),
      params: {},
      url: '/admin/ops',
    });
    expect(allowed).toBe('ops-body');
  });

  test('a denied actor never reaches the author component', async () => {
    let ran = false;
    const spying = defineAdmin({
      entities: [],
      pages: [
        {
          ...ops,
          component: () => {
            ran = true;
            return 'ops-body';
          },
        },
      ],
      auth,
    });
    const emitted = adminRoutes(spying)[0];
    const rendered = await emitted?.component?.({
      ctx: ctxFor(['admin:read']),
      params: {},
      url: '/admin/ops',
    });
    expect(ran).toBe(false);
    expect(rendered).not.toBe('ops-body');
  });

  test('a page declared with no permissions is refused at declaration', () => {
    expect(() => defineAdmin({ entities: [], pages: [{ ...ops, permissions: [] }], auth })).toThrow(
      /X_ADMIN_PAGE_UNGUARDED/,
    );
  });

  test('a page whose path shadows a generated route is refused', () => {
    expect(() =>
      defineAdmin({
        entities: [post],
        resources: { admin_page_post: { path: '/posts' } },
        pages: [{ ...ops, path: '/posts' }],
        auth,
      }),
    ).toThrow(/X_ADMIN_PAGE_PATH_INVALID/);
  });

  test('a page path that is not rooted is refused', () => {
    expect(() => defineAdmin({ entities: [], pages: [{ ...ops, path: 'ops' }], auth })).toThrow(
      /X_ADMIN_PAGE_PATH_INVALID/,
    );
  });
});

describe('every unusable page path is refused, each with the shape that would have worked', () => {
  const REFUSED: readonly (readonly [string, string])[] = [
    ['ops', 'is not rooted'],
    ['/', 'is not a usable path'],
    ['/ops/', 'is not a usable path'],
    ['/ops//health', 'is not a usable path'],
  ];

  for (const [path, cause] of REFUSED) {
    test(`"${path}" is X_ADMIN_PAGE_PATH_INVALID (${cause})`, () => {
      let thrown: { code?: string; cause?: string; fix?: string } = {};
      try {
        defineAdmin({ entities: [], pages: [{ ...ops, path }], auth });
      } catch (error) {
        thrown = error as typeof thrown;
      }
      expect(thrown.code).toBe('X_ADMIN_PAGE_PATH_INVALID');
      expect(thrown.cause).toContain(cause);
      // The fix is the path that WOULD have worked, not a description of the rule.
      expect(thrown.fix).toContain("path: '/");
    });
  }

  test('a two-segment path is fine — only the malformed shapes above are refused', () => {
    expect(() =>
      defineAdmin({ entities: [], pages: [{ ...ops, path: '/ops/health' }], auth }),
    ).not.toThrow();
  });
});
