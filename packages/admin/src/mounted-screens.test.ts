// `defineAdmin({ entities, db })` and nothing else: every route of the table answers with a
// rendered screen — rows on the list, fields on the detail, a form that posts — through the
// framework's own server renderer, with the actor carried on core's request context exactly as
// the HTTP pipeline carries it. An actor without the grant gets the refusal, and a 403.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, generateMasterKey, runWithContext, userActor } from '@ultimat3/core';
import {
  boolean,
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { registerCatalog, resetCatalogs } from '@ultimat3/i18n';
import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import {
  defineRoles,
  knownPermissions,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminRouteResponse } from './screen-frame';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically:
// a static import compiles a `.tsx` before the plugin exists.
const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch, adminRoutes } = await import('./routes');

const KEY_ENV = 'ULTIMATE_SECRETS_KEY';
const previousKey = process.env[KEY_ENV];
const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();

const gadgets = entity('admin_mount_gadgets', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    stock: integer(),
    active: boolean().default(false),
    apiKey: text({ max: 200 }).sealed().nullable(),
    createdAt: timestamp().defaultNow(),
  },
});

const db = database({ gadgets }, { driver: memoryDriver() });

// The whole declaration. No repo, no page, no auth: the handle and the role map are the app's.
const admin = defineAdmin({ entities: [gadgets], db });

/** The same entity with the three seams used once each: a row action, an app-wide one, a page. */
const ran: string[] = [];
const acting = defineAdmin({
  entities: [gadgets],
  db,
  actions: [
    {
      name: 'gadget.activate',
      permission: 'admin_mount_gadgets:write',
      entity: 'admin_mount_gadgets',
      handle: async ({ input }) => {
        ran.push(`activate:${String(input['id'])}`);
      },
    },
    {
      name: 'gadget.scrap',
      permission: 'admin_mount_gadgets:delete',
      entity: 'admin_mount_gadgets',
      destructive: true,
      handle: async ({ input }) => {
        ran.push(`scrap:${String(input['id'])}`);
      },
    },
    {
      name: 'gadgets.reindex',
      permission: 'admin_mount_gadgets:write',
      handle: async () => {
        ran.push('reindex');
      },
    },
  ],
  pages: [
    {
      path: '/ops',
      titleKey: 'admin.admin_mount_gadgets.title',
      navGroup: 'admin.group.data',
      permissions: ['job:read'],
      component: () => 'the ops board',
    },
  ],
});

// The refusals below assert the framework's own wording (`admin.actor.anonymous`), and a file that
// ran first in this process may have left a probe over it: start from the shipped catalogs.
resetCatalogs();
registerCatalog('en', {
  'admin.admin_mount_gadgets.title': 'Gadgets',
  'admin.admin_mount_gadgets.field.id': 'Id',
  'admin.admin_mount_gadgets.field.title': 'Title',
  'admin.admin_mount_gadgets.field.stock': 'Stock',
  'admin.admin_mount_gadgets.field.active': 'Active',
  'admin.admin_mount_gadgets.field.apiKey': 'API key',
  'admin.admin_mount_gadgets.field.createdAt': 'Created',
  'admin.action.gadget.activate': 'Activate',
  'admin.action.gadget.scrap': 'Scrap',
  'admin.action.gadgets.reindex': 'Reindex',
});

const READ = ['admin:read', 'admin_mount_gadgets:read', 'job:read', 'audit:read'] as const;

const BASE = '/admin/admin_mount_gadgets';
let rowId = '';

beforeAll(async () => {
  process.env[KEY_ENV] = generateMasterKey();
  // `/admin/jobs` reads the process's queue, as it does in a served app.
  setJobDriver(createMemoryDriver());
  defineRoles({
    ...previousRoles,
    viewer: { grants: [...READ] },
    operator: {
      grants: [
        ...READ,
        'admin:write',
        'admin:destroy',
        'admin_mount_gadgets:write',
        'admin_mount_gadgets:delete',
      ],
    },
  });
  rowId = String(
    (await db.gadgets.insert({ title: 'Sprocket', stock: 7, apiKey: 'CANARY-KEY' })).id,
  );
  await db.gadgets.insert({ title: 'Flange', stock: 2 });
});

afterAll(() => {
  resetJobDriver();
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
  defineRoles(previousRoles);
  restorePermissions(previousPermissions);
  clearRegistry();
  resetCatalogs();
});

interface Answer {
  readonly response: AdminRouteResponse;
  readonly html: string;
}

/** One request, start to finish: match the URL, build the ctx off the request, render the body. */
const askOf = (
  app: typeof admin,
  role: string | null,
  path: string,
  form?: Readonly<Record<string, unknown>>,
): Promise<Answer> =>
  runWithContext(
    createContext({
      ...(role === null ? {} : { actor: userActor({ id: `u-${role}`, roles: [role] }) }),
      tz: 'UTC',
      locale: 'en',
    }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(app, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
      const response = await matched.route.respond({
        ctx: await app.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: form === undefined ? 'GET' : 'POST',
        form: form ?? null,
      });
      const html =
        response.kind === 'document'
          ? await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
          : '';
      return { response, html };
    },
  );

const ask = (
  role: string | null,
  path: string,
  form?: Readonly<Record<string, unknown>>,
): Promise<Answer> => askOf(admin, role, path, form);

const statusOf = (answer: Answer): number | string =>
  answer.response.kind === 'document' ? answer.response.status : answer.response.location;

describe('unit · defineAdmin({ entities, db }) serves its screens', () => {
  test('every route of the table has a screen — none is a path with nothing behind it', () => {
    const routes = adminRoutes(admin);
    expect(routes.map((route) => route.path)).toContain(`${BASE}/:id/edit`);
    for (const route of routes) expect(typeof route.respond).toBe('function');
    // One render mode, and no script: the list pages and the forms are links and native posts.
    expect(new Set(routes.map((route) => route.config.render))).toEqual(new Set(['ssr']));
    expect(new Set(routes.map((route) => route.config.hydrate))).toEqual(new Set(['never']));
  });

  test('the list renders the rows, each opening through a real link', async () => {
    const answer = await ask('viewer', BASE);
    expect(statusOf(answer)).toBe(200);
    expect(answer.html).toContain('Sprocket');
    expect(answer.html).toContain('Flange');
    expect(answer.html).toContain(`href="${BASE}/${rowId}"`);
    // The shell: the nav this actor may open, and who is acting.
    expect(answer.html).toContain(`href="${BASE}"`);
    expect(answer.html).toContain('u-viewer');
    // A viewer holds no write grant, so no create link is drawn.
    expect(answer.html).not.toContain(`${BASE}/new`);
  });

  test('paging is anchors: the next page is a URL carrying the cursor, and it resumes there', async () => {
    const small = defineAdmin({
      entities: [gadgets],
      db,
      resources: {
        admin_mount_gadgets: { pageSize: 1, defaultSort: { field: 'title', direction: 'asc' } },
      },
    });
    const first = (await askOf(small, 'viewer', BASE)).html;
    expect(first).toContain('Flange');
    expect(first).not.toContain('Sprocket');
    const href = /<a href="([^"]+)" rel="next"/.exec(first)?.[1] ?? '';
    expect(href).toContain(`${BASE}?cursor=`);
    // The only `<button>` is the exhausted side, disabled: an enabled one with a handler would be
    // a dead control on a page that never hydrates.
    expect(first).not.toMatch(/<button type="button"(?![^>]*disabled)/);

    const second = (await askOf(small, 'viewer', href)).html;
    expect(second).toContain('Sprocket');
    expect(second).not.toContain('Flange');
    expect(second).toContain('rel="prev"');
  });

  test('the detail renders the row, and never a sealed column', async () => {
    const answer = await ask('viewer', `${BASE}/${rowId}`);
    expect(statusOf(answer)).toBe(200);
    expect(answer.html).toContain('Sprocket');
    expect(answer.html).toContain('Stock');
    expect(answer.html).not.toContain('CANARY-KEY');
    expect(answer.html).not.toContain('API key');
    // A viewer may neither edit nor delete, so neither control exists.
    expect(answer.html).not.toContain(`${BASE}/${rowId}/edit`);
    expect(answer.html).not.toContain('method="post"');
  });

  test('a row that does not exist is a 404, inside the shell', async () => {
    const answer = await ask('viewer', `${BASE}/0190a000-0000-7000-8000-000000000000`);
    expect(statusOf(answer)).toBe(404);
    expect(answer.html).toContain('X_ADMIN_ENTITY_UNKNOWN');
  });

  test('the edit form is a native POST at its own URL, prefilled — except the sealed column', async () => {
    const answer = await ask('operator', `${BASE}/${rowId}/edit`);
    expect(statusOf(answer)).toBe(200);
    expect(answer.html).toContain(`method="post" action="${BASE}/${rowId}/edit"`);
    expect(answer.html).toContain('name="title"');
    expect(answer.html).toContain('value="Sprocket"');
    // Write-only: the input exists, as a password box, and carries no value.
    expect(answer.html).toContain('name="apiKey"');
    expect(answer.html).toContain('type="password"');
    expect(answer.html).not.toContain('CANARY-KEY');
    expect(answer.html).toContain('type="submit"');
  });

  test('a posted create writes the row and redirects to it', async () => {
    const answer = await ask('operator', `${BASE}/new`, {
      title: 'Widget',
      stock: '12',
      active: 'on',
      apiKey: 'NEW-SECRET',
    });
    expect(answer.response.kind).toBe('redirect');
    const [made] = await db.gadgets.where({ title: 'Widget' }).all();
    // Strings off the wire, typed on the row: the form decode is what crossed that gap.
    expect(made?.stock).toBe(12);
    expect(made?.active).toBe(true);
    expect(made?.apiKey).toBe('NEW-SECRET');
    expect(statusOf(answer)).toBe(`${BASE}/${String(made?.id)}`);
  });

  test('a refused create re-renders the form, 422, with what was typed and the issue', async () => {
    const answer = await ask('operator', `${BASE}/new`, { title: 'x'.repeat(200), stock: '3' });
    expect(statusOf(answer)).toBe(422);
    expect(answer.html).toContain('x-admin-issues');
    expect(answer.html).toContain(`value="${'x'.repeat(200)}"`);
    expect(await db.gadgets.where({ stock: 3 }).count()).toBe(0);
  });

  test('a posted edit patches the row; an empty sealed box leaves the stored secret alone', async () => {
    const answer = await ask('operator', `${BASE}/${rowId}/edit`, {
      title: 'Sprocket II',
      stock: '9',
      apiKey: '',
    });
    expect(statusOf(answer)).toBe(`${BASE}/${rowId}`);
    const [stored] = await db.gadgets.where({ id: rowId }).all();
    expect(stored?.title).toBe('Sprocket II');
    expect(stored?.stock).toBe(9);
    expect(stored?.apiKey).toBe('CANARY-KEY');
  });

  test('a delete needs the typed confirmation, then removes the row', async () => {
    const [doomed] = await db.gadgets.where({ title: 'Flange' }).all();
    const id = String(doomed?.id);
    const unconfirmed = await ask('operator', `${BASE}/${id}`, { _operation: 'delete' });
    expect(statusOf(unconfirmed)).toBe(403);
    expect(await db.gadgets.where({ id }).count()).toBe(1);

    const confirmed = await ask('operator', `${BASE}/${id}`, {
      _operation: 'delete',
      confirmation: `admin_mount_gadgets:${id}`,
    });
    expect(statusOf(confirmed)).toBe(BASE);
    expect(await db.gadgets.where({ id }).count()).toBe(0);
  });
});

describe('unit · an actor without the permission gets the refusal', () => {
  test('anonymous: 403, the permission named, and no row in the document', async () => {
    const answer = await ask(null, BASE);
    expect(statusOf(answer)).toBe(403);
    expect(answer.html).toContain('admin:read');
    expect(answer.html).not.toContain('Sprocket');
    expect(answer.html).toContain('not signed in');
  });

  test('a viewer who POSTs a write is refused by the same decision that hid the form', async () => {
    const form = await ask('viewer', `${BASE}/new`);
    expect(statusOf(form)).toBe(403);
    const write = await ask('viewer', `${BASE}/new`, { title: 'Forged', stock: '1' });
    expect(statusOf(write)).toBe(403);
    expect(await db.gadgets.where({ title: 'Forged' }).count()).toBe(0);
    // Both refusals are on the log — a denial is the entry an auditor wants.
    const denied = (await admin.audit.entries()).filter((entry) => entry.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });

  test('the dashboard, jobs, audit and search screens are each decided by their own route', async () => {
    for (const path of ['/admin', '/admin/jobs', '/admin/audit', '/admin/search?term=Sprocket']) {
      expect({ path, status: statusOf(await ask('viewer', path)) }).toEqual({ path, status: 200 });
      expect({ path, status: statusOf(await ask(null, path)) }).toEqual({ path, status: 403 });
    }
    const found = await ask('viewer', '/admin/search?term=Sprocket');
    expect(found.html).toContain(`href="${BASE}/${rowId}"`);
  });

  test('a URL the admin does not declare matches nothing', () => {
    expect(adminRouteMatch(admin, '/admin/nope/at/all')).toBeNull();
    // The most specific pattern wins: `new` is the create form, never a row called "new".
    expect(adminRouteMatch(admin, `${BASE}/new`)?.route.view).toBe('create');
  });
});

describe('unit · the dashboard is the decision, rendered', () => {
  test('each resource the actor may open, with the permission pair behind every operation', async () => {
    const viewer = await ask('viewer', '/admin');
    expect(viewer.html).toContain(`href="${BASE}"`);
    expect(viewer.html).toContain('admin:read + admin_mount_gadgets:read');
    expect(viewer.html).toContain('admin:write + admin_mount_gadgets:write');
    // View-only is a permission, not a UI state: the write row reads as denied, and why.
    expect(viewer.html).toContain('denied — actor lacks admin:write');

    const operator = await ask('operator', '/admin');
    expect(operator.html).not.toContain('denied —');
  });

  test('no row is read to draw it — the dashboard is not one query per entity', async () => {
    const before = (await admin.audit.entries()).length;
    await ask('viewer', '/admin');
    // A list read is audited; a dashboard render that leaves the log alone read no table.
    expect((await admin.audit.entries()).length).toBe(before);
  });
});

describe('unit · actions are native forms, decided by the gate that drew them', () => {
  test('a viewer sees no action form; an operator sees one per allowed action, per row', async () => {
    const viewer = await askOf(acting, 'viewer', BASE);
    expect(viewer.html).not.toContain('Activate');
    expect(viewer.html).not.toContain('name="_operation"');

    const operator = await askOf(acting, 'operator', BASE);
    expect(operator.html).toContain(`method="post" action="${BASE}/${rowId}"`);
    expect(operator.html).toContain('name="name" value="gadget.activate"');
    expect(operator.html).toContain('Scrap');
  });

  test('a posted action runs against the row its URL names, then lands on that row', async () => {
    const answer = await askOf(acting, 'operator', `${BASE}/${rowId}`, {
      _operation: 'action',
      name: 'gadget.activate',
    });
    // The row, where its new state and the history entry the action just wrote are both on screen.
    expect(statusOf(answer)).toBe(`${BASE}/${rowId}`);
    expect(ran).toContain(`activate:${rowId}`);
  });

  test('a destructive one refuses without the echo and runs with it', async () => {
    const bare = await askOf(acting, 'operator', `${BASE}/${rowId}`, {
      _operation: 'action',
      name: 'gadget.scrap',
    });
    expect(statusOf(bare)).toBe(403);
    expect(ran).not.toContain(`scrap:${rowId}`);

    const echoed = await askOf(acting, 'operator', `${BASE}/${rowId}`, {
      _operation: 'action',
      name: 'gadget.scrap',
      confirmation: `admin_mount_gadgets:${rowId}`,
    });
    expect(statusOf(echoed)).toBe(`${BASE}/${rowId}`);
    expect(ran).toContain(`scrap:${rowId}`);
  });

  test('a forged POST from an actor without the grant is refused and audited, and nothing runs', async () => {
    const before = ran.length;
    const answer = await askOf(acting, 'viewer', `${BASE}/${rowId}`, {
      _operation: 'action',
      name: 'gadget.activate',
    });
    expect(statusOf(answer)).toBe(403);
    expect(ran.length).toBe(before);
    expect(
      (await acting.audit.entries()).some(
        (entry) => entry.operation === 'gadget.activate' && entry.outcome === 'denied',
      ),
    ).toBe(true);
  });

  test('a name this resource does not declare is a 404 — which operation comes before may-I', async () => {
    const answer = await askOf(acting, 'operator', `${BASE}/${rowId}`, {
      _operation: 'action',
      name: 'gadget.detonate',
    });
    expect(statusOf(answer)).toBe(404);
  });

  test('an app-wide action posts at the dashboard and lands back on it', async () => {
    const home = await askOf(acting, 'operator', '/admin');
    expect(home.html).toContain('method="post" action="/admin"');
    expect(home.html).toContain('name="name" value="gadgets.reindex"');

    const answer = await askOf(acting, 'operator', '/admin', {
      _operation: 'action',
      name: 'gadgets.reindex',
    });
    expect(statusOf(answer)).toBe('/admin');
    expect(ran).toContain('reindex');

    const unknown = await askOf(acting, 'operator', '/admin', {
      _operation: 'action',
      name: 'nope',
    });
    expect(statusOf(unknown)).toBe(404);
  });
});

describe('unit · a custom page is served by the same mount', () => {
  test('framed in the shell, linked in the nav, and refused for an actor without its permission', async () => {
    const allowed = await askOf(acting, 'viewer', '/admin/ops');
    expect(statusOf(allowed)).toBe(200);
    expect(allowed.html).toContain('the ops board');
    expect(allowed.html).toContain('href="/admin/ops"');

    const refused = await askOf(acting, null, '/admin/ops');
    expect(statusOf(refused)).toBe(403);
    expect(refused.html).not.toContain('the ops board');
  });
});
