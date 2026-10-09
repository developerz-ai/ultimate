// An app FILE serving an admin path in the admin's place (`claimAdminRoute`), so an app keeps its
// own shell and its islands. What must hold whatever the app supplies: the route is the admin's
// gate (staff only, `admin:read` coarse), the page's own permission is decided by the SAME
// screen the catch-all serves — refusal audited, 403, the author's component never called — and
// no config the admin did not issue can take a mounted path.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry } from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import {
  clearRoutes,
  defineRoute,
  island,
  type RouteConfig,
  RouteDuplicateError,
  registerRoute,
  routeStatusOf,
  withStatus,
} from '@ultimat3/render';
import type { AdminApp } from './admin';
import { memoryAuditLog } from './audit';
import type { AdminActor, AdminAuthz, AdminDecision } from './authz';
import { adminAllowed, adminDenied } from './authz';
import type { AdminClaimData } from './claim-route';
import { AdminPagePathInvalidError } from './errors';
import type { AdminPageProps } from './pages';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { claimAdminRoute } = await import('./claim-route');

registerCatalog('en', {
  'admin.ops.title': 'Ops (probe)',
  'admin.denied.body': 'Refused {permission} because {reason} (probe)',
});

const ACTOR: AdminActor = { id: 'u_1', roles: ['staff'] };
const audit = memoryAuditLog();
let grant = new Set<string>();
const authz: AdminAuthz = {
  decide: ({ permission }): AdminDecision =>
    grant.has(permission)
      ? adminAllowed(permission, 'probe.granted')
      : adminDenied(permission, 'probe.not-granted'),
};

const called: AdminPageProps[] = [];
let app: AdminApp;
beforeAll(() => {
  app = defineAdmin({
    entities: [],
    basePath: '/back-office',
    audit,
    auth: { actor: () => ACTOR, authz },
    pages: [
      {
        path: '/ops',
        titleKey: 'admin.ops.title',
        permissions: ['ops:read'],
        component: (props) => {
          called.push(props);
          return 'the ops body';
        },
      },
    ],
  });
});

afterEach(() => {
  clearRoutes();
  called.length = 0;
  grant = new Set();
});
afterAll(clearRegistry);

const URL_OPS = 'http://localhost/back-office/ops';
const FILE = 'apps/admin/app/back-office/ops/page.tsx';

const load = async <T>(config: RouteConfig<AdminClaimData<T>>): Promise<AdminClaimData<T>> => {
  const run = config.load ?? expect.unreachable('the claimed route has no load');
  return await run({ params: {}, url: URL_OPS });
};

const html = (data: AdminClaimData<unknown>): Promise<string> =>
  renderComponent(() => data.body, {}, FILE);

describe('the claimed route is the admin’s route', () => {
  test('ssr, network-only, gated on admin:read, never indexed — none of it the app’s to pass', async () => {
    const config = claimAdminRoute(app, '/back-office/ops');
    expect(config.render).toBe('ssr');
    expect(config.offline).toBe('network-only');
    expect(config.policy).toEqual({ permission: 'admin:read' });
    const meta = await config.meta({ data: await load(config), params: {}, url: URL_OPS } as never);
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  test('an island declared above it is the route’s: it hydrates, unlike every admin screen', () => {
    island({ src: './ops-panel.island.tsx', props: [] });
    const config = claimAdminRoute(app, '/back-office/ops', { budget: { js: '40kb' } });
    expect(config.islands.map((spec) => spec.moduleId)).toEqual(['ops-panel']);
    expect(config.hydrate).not.toBe('never');
    expect(config.budget.js).toBe('40kb');
  });

  test('a path the admin does not declare, or a generated screen, is refused', () => {
    expect(() => claimAdminRoute(app, '/back-office/nope')).toThrow(AdminPagePathInvalidError);
    expect(() => claimAdminRoute(app, '/back-office/audit')).toThrow(AdminPagePathInvalidError);
    const refusal = (() => {
      try {
        claimAdminRoute(app, '/back-office/audit');
      } catch (error) {
        return error;
      }
      return expect.unreachable('a generated screen was claimed');
    })();
    // The fix names what CAN be claimed: the pages and the dashboard, never a generated screen.
    expect((refusal as AdminPagePathInvalidError).fix).toContain('/back-office/ops');
    expect((refusal as AdminPagePathInvalidError).fix).not.toContain('/back-office/audit');
  });

  test('the dashboard may be claimed: an app with its own home keeps it', () => {
    expect(claimAdminRoute(app, '/back-office').policy).toEqual({ permission: 'admin:read' });
  });
});

describe('load: the screen decides, the app frames', () => {
  test('allowed: the page body, UNframed, with the nav and what the app’s own load read', async () => {
    grant = new Set(['admin:read', 'ops:read']);
    const config = claimAdminRoute(app, '/back-office/ops', {
      load: ({ denied, ctx }) => ({ who: ctx.actor.id, denied }),
    });
    const data = await load(config);
    expect(data).toMatchObject({
      status: 200,
      denied: false,
      titleKey: 'admin.ops.title',
      app: { who: 'u_1', denied: false },
    });
    expect(Array.isArray(data.nav)).toBe(true);
    const out = await html(data);
    expect(out).toContain('the ops body');
    // No admin layout around it: the app's own shell is the frame.
    expect(out).not.toContain('id="x-admin-main"');
    expect(called).toHaveLength(1);
    expect(called[0]?.url).toBe(URL_OPS);
  });

  test('refused: the author’s component is never called, the refusal is audited, 403', async () => {
    grant = new Set(['admin:read']);
    const before = (await audit.entries()).length;
    const data = await load(claimAdminRoute(app, '/back-office/ops', { load: () => ({}) }));
    expect(called).toEqual([]);
    expect(data.denied).toBe(true);
    expect(data.status).toBe(403);
    expect(routeStatusOf(data)).toBe(403);
    expect(await html(data)).toContain('Refused ops:read because probe.not-granted');
    const entries = await audit.entries();
    expect(entries.length).toBe(before + 1);
    expect(entries[0]).toMatchObject({ entity: '/back-office/ops', operation: 'page' });
  });

  test('not staff (no admin:read) is refused by the screen too, not only by the pipeline', async () => {
    grant = new Set(['ops:read']);
    const data = await load(claimAdminRoute(app, '/back-office/ops'));
    expect(called).toEqual([]);
    expect(data.status).toBe(403);
  });

  test('an app load answering withStatus sets the page’s status; a refusal stays 403', async () => {
    grant = new Set(['admin:read', 'ops:read']);
    const notFound = claimAdminRoute(app, '/back-office/ops', {
      load: () => withStatus(404, {}),
    });
    expect(routeStatusOf(await load(notFound))).toBe(404);
    grant = new Set(['admin:read']);
    expect(routeStatusOf(await load(notFound))).toBe(403);
  });
});

describe('refusal: an app page cannot escape the admin guard', () => {
  test('the issued config registers at its path; a hand-written route there is X_ROUTE_DUPLICATE', () => {
    // `defineAdmin` mounted its routes in `beforeAll`; `clearRoutes()` after each test dropped
    // them, so declare the admin again for the route table.
    const fresh = defineAdmin({
      entities: [],
      basePath: '/back-office',
      audit,
      auth: { actor: () => ACTOR, authz },
      pages: [
        {
          path: '/ops',
          titleKey: 'admin.ops.title',
          permissions: ['ops:read'],
          component: () => '',
        },
      ],
    });
    const forged = defineRoute({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      policy: { permission: 'admin:read' },
      meta: () => ({ title: 'ops' }),
      load: () => ({ body: 'no guard here' }),
    });
    expect(() => registerRoute({ file: FILE, config: forged })).toThrow(RouteDuplicateError);

    const claimed = claimAdminRoute(fresh, '/back-office/ops');
    // A copy with its own `load` is a new config the admin never issued.
    const swapped = defineRoute({ ...claimed, load: async () => ({}) as never });
    expect(() => registerRoute({ file: FILE, config: swapped })).toThrow(RouteDuplicateError);
    // Issued for /ops, registered at the dashboard's path: refused.
    expect(() =>
      registerRoute({ file: 'apps/admin/app/back-office/page.tsx', config: claimed }),
    ).toThrow(RouteDuplicateError);

    expect(() => registerRoute({ file: FILE, config: claimed })).not.toThrow();
  });
});
