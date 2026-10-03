// The specification for a custom admin page: it is reachable, it is in the nav, and it CANNOT
// be mounted without its guard. Every assertion here failed before `pages.ts` existed — the
// route table had no slot for a page, and `adminRoutes()` threw on the first route it built.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import type { AdminApp } from './admin';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import type { AdminCustomPage } from './pages';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically:
// `routes.ts` reaches the screens, and a static import compiles a `.tsx` before the plugin exists.
await import('@ultimat3/render/server');
const { adminRoutes } = await import('./routes');

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

let app: AdminApp;
beforeAll(() => {
  app = defineAdmin({
    entities: [post],
    db: database({ post }, { driver: memoryDriver() }),
    resources: { admin_page_post: { path: '/posts' } },
    pages: [ops],
    auth,
  });
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

  const ask = (target: typeof app, granted: readonly string[]) =>
    adminRoutes(target)
      .find((candidate) => candidate.path === '/admin/ops')
      ?.respond({
        ctx: ctxFor(granted),
        params: {},
        url: 'http://localhost/admin/ops',
        method: 'GET',
        form: null,
      });

  test('the route table exposes a SCREEN — the author’s component is not reachable from it', async () => {
    const emitted = adminRoutes(app).find((candidate) => candidate.path === '/admin/ops');
    // No `component` on the emitted route at all: the only way in is `respond`, which decides.
    expect(emitted === undefined ? [] : Object.keys(emitted)).not.toContain('component');

    const allowed = await ask(app, ['admin:read', 'ops:read']);
    expect(allowed?.kind === 'document' && allowed.status).toBe(200);
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
    const refused = await ask(spying, ['admin:read']);
    expect(ran).toBe(false);
    expect(refused?.kind === 'document' && refused.status).toBe(403);

    // The same screen, an actor who holds the grant: the component DOES run — the spy can fire.
    await ask(spying, ['admin:read', 'ops:read']);
    expect(ran).toBe(true);
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
        db: database({ post }, { driver: memoryDriver() }),
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
