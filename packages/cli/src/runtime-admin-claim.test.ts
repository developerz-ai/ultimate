// An app file that CLAIMED an admin path (`claimAdminRoute`), served beside the admin's catch-all
// through the real HTTP pipeline: the file's document (its own shell, its island), the screen's
// decision inside it (403 for staff missing the page's grant, the author's component not run),
// the pipeline's auth before either, and the dashboard's GET claimable without a route conflict.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import { clearRegistry } from '@ultimat3/entity';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import { clearRoutes, describePages, island, registerRoute } from '@ultimat3/render';
import { adminMountRoutes } from './runtime-admin';
import { devHooks } from './runtime-hooks';
import { appRoutes } from './runtime-render';

await import('@ultimat3/render/server');
const { clearAdminMounts, claimAdminRoute, defineAdmin } = await import('@ultimat3/admin');

const BUILD_ID = 'build-under-test';
const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const STAFF = userActor({ id: 'staff', roles: ['cli_claim_staff'] });
const OPS = userActor({ id: 'ops', roles: ['cli_claim_ops'] });
const CUSTOMER = userActor({ id: 'customer', roles: ['cli_claim_customer'] });

const ran: string[] = [];
const OPS_FILE = 'apps/admin/app/admin/ops/page.tsx';

beforeAll(() => {
  clearAdminMounts();
  clearRoutes();
  const admin = defineAdmin({
    entities: [],
    pages: [
      {
        path: '/ops',
        titleKey: 'admin.ops.title',
        permissions: ['cli_claim_ops:read'],
        component: () => {
          ran.push('ops');
          return 'the ops body';
        },
      },
    ],
  });
  defineRoles({
    ...previousRoles,
    cli_claim_staff: { grants: ['admin:read'] },
    cli_claim_ops: { grants: ['admin:read', 'cli_claim_ops:read'] },
    cli_claim_customer: { grants: [] },
  });

  // The page module, as an app writes it: the island above the claim, the shell in the component.
  const Panel = island({ src: './ops-panel.island.tsx', props: ['label'] });
  const ops = claimAdminRoute(admin, '/admin/ops', {
    load: ({ ctx }) => ({ who: ctx.actor.id }),
  });
  registerRoute({
    file: OPS_FILE,
    config: ops,
    component: (props) => {
      const data = props['data'] as { readonly body: unknown; readonly app: unknown };
      return ['<app-shell>', data.body, Panel({ label: 'panel' }), JSON.stringify(data.app)];
    },
  });
  const home = claimAdminRoute(admin, '/admin');
  registerRoute({
    file: 'apps/admin/app/admin/page.tsx',
    config: home,
    component: () => 'the app home',
  });
});

afterAll(() => {
  clearAdminMounts();
  clearRoutes();
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

const serve = (actor: Actor | null) =>
  httpServer({
    routes: [...adminMountRoutes({ buildId: BUILD_ID }), ...appRoutes({ buildId: BUILD_ID })],
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    // The production pair: the page's `policy` decided by the app's policies, as for any page.
    hooks: { ...devHooks(), authenticate: () => actor },
  });

const get = (actor: Actor | null, path: string): Promise<Response> =>
  serve(actor).fetch(new Request(`http://dev.test${path}`));

describe('unit · a claimed admin path', () => {
  test('the claimed GET is the file’s; the catch-all keeps every other path and every POST', () => {
    expect(adminMountRoutes({ buildId: BUILD_ID }).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /admin',
      'GET /admin/*rest',
      'POST /admin/*rest',
    ]);
    const row = describePages().find((route) => route.path === '/admin/ops');
    expect(row).toMatchObject({ file: OPS_FILE, mount: { by: 'defineAdmin', claimed: true } });
    expect(row?.islands).toEqual(['ops-panel']);
  });

  test('allowed: the app’s shell, the page body, its island booted', async () => {
    ran.length = 0;
    const response = await get(OPS, '/admin/ops');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('&lt;app-shell&gt;');
    expect(html).toContain('the ops body');
    expect(html).toContain('{&quot;who&quot;:&quot;ops&quot;}');
    expect(html).toContain('data-x-entry');
    expect(html).not.toContain('id="x-admin-main"');
    expect(html).toContain('noindex');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(ran).toEqual(['ops']);
  });

  test('staff without the page’s grant: the screen’s 403 inside the app shell, body never run', async () => {
    ran.length = 0;
    const response = await get(STAFF, '/admin/ops');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('cli_claim_ops:read');
    expect(ran).toEqual([]);
  });

  test('not staff: refused before the file renders; anonymous: the auth stage answers', async () => {
    ran.length = 0;
    expect((await get(CUSTOMER, '/admin/ops')).status).toBe(403);
    expect((await get(null, '/admin/ops')).status).toBe(401);
    expect(ran).toEqual([]);
  });

  test('the dashboard claimed: GET /admin is the app’s home, no route conflict', async () => {
    const response = await get(STAFF, '/admin');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('the app home');
    expect((await get(CUSTOMER, '/admin')).status).toBe(403);
  });
});
