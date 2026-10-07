// The admin mount, through the real HTTP pipeline: `defineAdmin()` and nothing else is a list, a
// detail and a form at a URL. What this file pins is the CROSSING — the catch-all, the status, the
// native POST becoming a 303, the gate being the screen's — not the screens, which are the admin's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { frameworkSources } from '@ultimat3/manifest';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import { describePages, routeEntries } from '@ultimat3/render';
import { ADMIN_MOUNT_FILE, adminMountRoutes } from './runtime-admin';

// After `@ultimat3/render/server` installed its `.tsx` loader, exactly as `loadApp` orders it for
// an app: the admin's screens are `.tsx`, and a plugin only transforms modules loaded after it.
await import('@ultimat3/render/server');
const { ADMIN_MOUNTS, adminMounts, clearAdminMounts, defineAdmin } = await import(
  '@ultimat3/admin'
);

const BUILD_ID = 'build-under-test';
const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const parts = entity('cli_admin_parts', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }), stock: integer() },
});
const db = database({ parts }, { driver: memoryDriver() });

const VIEWER = userActor({ id: 'viewer', roles: ['cli_admin_viewer'] });
const OPERATOR = userActor({ id: 'operator', roles: ['cli_admin_operator'] });

let rowId = '';

beforeAll(async () => {
  clearAdminMounts();
  defineAdmin({ entities: [parts], db });
  defineRoles({
    ...previousRoles,
    cli_admin_viewer: { grants: ['admin:read', 'cli_admin_parts:read'] },
    cli_admin_operator: {
      grants: ['admin:read', 'admin:write', 'cli_admin_parts:read', 'cli_admin_parts:write'],
    },
  });
  rowId = String((await db.parts.insert({ title: 'Sprocket', stock: 7 })).id);
});

afterAll(() => {
  clearAdminMounts();
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

const serve = (actor: Actor | null) =>
  httpServer({
    routes: adminMountRoutes({ buildId: BUILD_ID }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor },
  });

const get = (actor: Actor | null, path: string): Promise<Response> =>
  serve(actor).fetch(new Request(`http://dev.test${path}`));

const post = (
  actor: Actor | null,
  path: string,
  fields: Record<string, string>,
): Promise<Response> =>
  serve(actor).fetch(
    new Request(`http://dev.test${path}`, {
      method: 'POST',
      // Same-origin, as a browser posting the form the page rendered sends it.
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://dev.test',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );

describe('unit · the admin mount', () => {
  test('the CLI names the registry the admin package writes — one string, held equal', () => {
    expect(ADMIN_MOUNTS).toBe(Symbol.for('ultimate.admin.mounts'));
  });

  // Define once, project everywhere: the routes `defineAdmin()` derives are in the framework's one
  // route list and in the manifest — as mounted routes with their permissions, never as a page
  // file — and the manifest records what each resource's list answers.
  test('the declared admin is in describePages() and in the manifest, with no page file pretended', () => {
    const listed = describePages().filter((route) => route.mount?.by === 'defineAdmin');
    expect(listed.map((route) => route.path)).toContain('/admin/cli_admin_parts/:id/edit');
    expect(listed.find((route) => route.path === '/admin/cli_admin_parts')).toMatchObject({
      file: ADMIN_MOUNT_FILE,
      mode: 'ssr',
      hydrate: 'never',
      mount: { by: 'defineAdmin', permissions: ['admin:read', 'cli_admin_parts:read'] },
    });
    expect(routeEntries().filter((entry) => entry.path.startsWith('/admin'))).toEqual([]);

    const [recorded] = frameworkSources({ app: { name: 'a', version: '1.0.0' } }).admin ?? [];
    expect(recorded?.basePath).toBe('/admin');
    // The app's one resource, and after it (sorted by name) the jobs dashboard every admin carries.
    expect(recorded?.resources.map((resource) => resource.entity)).toEqual([
      'cli_admin_parts',
      'x_job_queues',
      'x_job_tasks',
      'x_job_workers',
      'x_jobs',
    ]);
    expect(recorded?.resources.slice(0, 1)).toEqual([
      {
        entity: 'cli_admin_parts',
        path: '/cli_admin_parts',
        // The label first — the list's search box — then the key.
        filters: ['title', 'id'],
        sorts: ['id', 'stock'],
        scopes: [],
        rowScoped: false,
        // No declaration: one untitled group each, nothing related, no action.
        sections: [{ title: null, fields: ['id', 'title', 'stock'] }],
        formGroups: [{ title: null, fields: ['title', 'stock'] }],
        related: [],
        actions: [],
      },
    ]);
    expect(recorded?.audit).toBe('memory');
    expect(recorded?.routes.find((route) => route.url === '/admin/cli_admin_parts/new')).toEqual({
      url: '/admin/cli_admin_parts/new',
      view: 'create',
      entity: 'cli_admin_parts',
      permissions: ['admin:write', 'cli_admin_parts:write'],
    });
    // The manifest's reader and the admin's own description cannot drift: one is the other, read.
    expect(recorded).toEqual(JSON.parse(JSON.stringify(adminMounts()[0]?.describe())));
  });

  test('one catch-all per admin and per method, and nothing for an app that declared none', () => {
    const routes = adminMountRoutes({ buildId: BUILD_ID });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /admin',
      'POST /admin',
      'GET /admin/*rest',
      'POST /admin/*rest',
    ]);
    // The screen holds the row a rule reads, so the pipeline's `authz` stage must not pre-judge.
    expect(new Set(routes.map((route) => route.meta.enforcedBy))).toEqual(new Set(['handler']));
    expect(new Set(routes.map((route) => route.meta.auth))).toEqual(new Set(['required']));
  });

  test('GET /admin/<resource> is a whole document with the rows in it', async () => {
    const response = await get(VIEWER, '/admin/cli_admin_parts');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('Sprocket');
    expect(body).toContain(`href="/admin/cli_admin_parts/${rowId}"`);
    // Per-actor rows: never something a shared cache may hold.
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    // No script at all: every control is a link or a native form.
    expect(body).not.toContain('<script');
    expect(ADMIN_MOUNT_FILE).toBe('@ultimat3/admin');
  });

  test("a screen carries the app's brand after its stylesheet, and none without one", async () => {
    const brand = '<style>:root{--color-accent:1 2 3}</style>';
    const branded = httpServer({
      routes: adminMountRoutes({ buildId: BUILD_ID, brandHead: brand }),
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => VIEWER },
    });
    const response = await branded.fetch(new Request('http://dev.test/admin/cli_admin_parts'));
    const head = (await response.text()).split('</head>')[0] ?? '';
    expect(head).toContain(brand);
    expect(await (await get(VIEWER, '/admin/cli_admin_parts')).text()).not.toContain(brand);
  });

  test('the detail and the form routes answer under the same catch-all', async () => {
    expect((await get(VIEWER, `/admin/cli_admin_parts/${rowId}`)).status).toBe(200);
    const form = await get(OPERATOR, `/admin/cli_admin_parts/${rowId}/edit`);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain(
      `method="post" action="/admin/cli_admin_parts/${rowId}/edit"`,
    );
  });

  test('a posted form writes, and the browser is sent to the row with a 303', async () => {
    const response = await post(OPERATOR, '/admin/cli_admin_parts/new', {
      title: 'Flange',
      stock: '3',
    });
    expect(response.status).toBe(303);
    const [made] = await db.parts.where({ title: 'Flange' }).all();
    expect(made?.stock).toBe(3);
    expect(response.headers.get('location')).toBe(`/admin/cli_admin_parts/${String(made?.id)}`);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('a refused form is a 422 document, not a redirect', async () => {
    const response = await post(OPERATOR, '/admin/cli_admin_parts/new', {
      title: 'x'.repeat(200),
      stock: '1',
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('x-admin-issues');
  });

  test('an actor without the grant gets the admin’s own refusal, as a 403', async () => {
    const response = await get(VIEWER, '/admin/cli_admin_parts/new');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('admin:write');
    const forged = await post(VIEWER, '/admin/cli_admin_parts/new', {
      title: 'Forged',
      stock: '1',
    });
    expect(forged.status).toBe(403);
    expect(await db.parts.where({ title: 'Forged' }).count()).toBe(0);
  });

  test('anonymous never reaches a screen — the pipeline’s own auth stage answers', async () => {
    expect((await get(null, '/admin/cli_admin_parts')).status).toBe(401);
  });

  test('a URL under the base path that the admin does not declare is the ordinary 404', async () => {
    expect((await get(VIEWER, '/admin/nope/at/all')).status).toBe(404);
  });

  test('a cross-site POST is refused before the screen runs', async () => {
    const response = await serve(OPERATOR).fetch(
      new Request('http://dev.test/admin/cli_admin_parts/new', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://evil.test',
          'sec-fetch-site': 'cross-site',
        },
        body: 'title=Forged+cross+site&stock=1',
      }),
    );
    expect(response.status).toBe(403);
    expect(await db.parts.where({ title: 'Forged cross site' }).count()).toBe(0);
  });
});
