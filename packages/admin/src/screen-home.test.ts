// `/admin` home, rendered as a request renders it: a KPI row counting what this actor may list —
// through each resource's own repo and its row scope, never a query of its own — a chart of the
// same counts, and the permission matrix below them. A resource the actor may not list is in none
// of the three, its count included.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { registerCatalog, resetCatalogs } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';

// After `@ultimat3/render/server` has installed its `.tsx` loader, and never statically.
const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const widgets = entity('home_widgets', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }), owner: text({ max: 80 }) },
});
const vaults = entity('home_vaults', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }) },
});
const db = database({ widgets, vaults }, { driver: memoryDriver() });

let open: AdminApp;
let scoped: AdminApp;
const COUNTED = { home_widgets: { count: true }, home_vaults: { count: true } } as const;

beforeAll(async () => {
  resetCatalogs();
  registerCatalog('en', {
    'admin.home_widgets.title': 'Widgets',
    'admin.home_vaults.title': 'Vaults',
  });
  defineRoles({
    ...previousRoles,
    // Reads widgets, not vaults: the vault count is the number a viewer must not learn.
    viewer: { grants: ['admin:read', 'home_widgets:read'] },
    keeper: { grants: ['admin:read', 'home_widgets:read', 'home_vaults:read'] },
  });
  // `count: true` on both: a home tile is a full count per visit, so it is asked for per resource.
  open = defineAdmin({ entities: [widgets, vaults], db, resources: COUNTED });
  scoped = defineAdmin({
    entities: [widgets, vaults],
    db,
    resources: {
      ...COUNTED,
      home_widgets: {
        count: true,
        rows: (actor) => [{ field: 'owner', op: 'eq', value: actor.id }],
      },
    },
  });
  await db.widgets.insert({ title: 'Sprocket', owner: 'u-viewer' });
  await db.widgets.insert({ title: 'Flange', owner: 'u-viewer' });
  await db.widgets.insert({ title: 'Gasket', owner: 'u-someone-else' });
  for (const title of ['A', 'B', 'C', 'D', 'E']) await db.vaults.insert({ title });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
  resetCatalogs();
});

const home = (app: AdminApp, role: string): Promise<string> =>
  runWithContext(
    ctxOf({
      actor: userActor({ id: `u-${role}`, roles: [role] }),
      tz: 'UTC',
      locale: 'en',
    }),
    async () => {
      const url = 'http://localhost/admin';
      const matched = adminRouteMatch(app, '/admin');
      if (matched === null) return expect.unreachable('no admin route matches /admin');
      const response = await matched.route.respond({
        ctx: await app.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: 'GET',
        form: null,
      });
      if (response.kind !== 'document') return expect.unreachable('the home is a document');
      return renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx');
    },
  );

/** The figure a KPI tile shows, read off the markup by the `stat` the screen gave it. */
const stat = (html: string, name: string): string | undefined =>
  html.match(new RegExp(`data-stat="${name}">([^<]*)<`))?.[1];

describe('unit · /admin home counts what the actor may list', () => {
  test('one KPI tile per listable resource, its figure the repo count', async () => {
    const html = await home(open, 'keeper');
    expect(stat(html, 'admin-count-home_widgets')).toBe('3');
    expect(stat(html, 'admin-count-home_vaults')).toBe('5');
    // The tile is a link into the list it counts.
    expect(html).toMatch(/href="\/admin\/home_widgets"[^>]*>\s*<div[^>]*>\s*<p[^>]*>Widgets/);
  });

  test('a resource the actor may not list has no tile, no bar and no matrix', async () => {
    const html = await home(open, 'viewer');
    expect(stat(html, 'admin-count-home_widgets')).toBe('3');
    expect(stat(html, 'admin-count-home_vaults')).toBeUndefined();
    expect(html).not.toContain('Vaults');
    expect(html).not.toContain('home_vaults');
  });

  test('the count honours the row scope: only the rows this actor could open', async () => {
    const html = await home(scoped, 'viewer');
    expect(stat(html, 'admin-count-home_widgets')).toBe('2');
  });

  test('the chart draws one segment per counted resource, largest first, with a data table', async () => {
    const html = await home(open, 'keeper');
    expect(html.match(/data-segment="/g)).toHaveLength(2);
    expect(html).toContain('Records per resource');
    // The centre figure is the total across what the actor may open.
    expect(html).toMatch(/>8<\/span>/);
    // The visually hidden fallback names each resource beside its figure, largest first.
    const vaults = html.search(/<th[^>]*>Vaults<\/th>\s*<td[^>]*>5<\/td>/);
    const widgetsRow = html.search(/<th[^>]*>Widgets<\/th>\s*<td[^>]*>3<\/td>/);
    expect(vaults).toBeGreaterThan(-1);
    expect(widgetsRow).toBeGreaterThan(vaults);
  });

  test('the permission matrix stays, below the KPIs', async () => {
    const html = await home(open, 'viewer');
    const kpis = html.indexOf('data-stat="admin-count-home_widgets"');
    const matrix = html.indexOf('admin:read + home_widgets:read');
    expect(kpis).toBeGreaterThan(-1);
    expect(matrix).toBeGreaterThan(kpis);
  });

  test('each matrix is a closed disclosure whose summary counts what is allowed', async () => {
    const html = await home(open, 'viewer');
    // Closed by default and no script: a native <details>, the summary naming the resource.
    expect(html).toMatch(
      /<details class="[^"]*"><summary[^>]*>[\s\S]*?Widgets[\s\S]*?3 of 6 allowed/,
    );
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // Every verdict is still in the document, inside the disclosure.
    expect(html).toContain('denied — actor lacks admin:write');
    expect(html).toContain('href="/admin/home_widgets"');
  });

  // A count the store refuses — a tenant-scoped table asked by an actor with no org answers
  // X_TENANCY_UNSCOPED — costs that resource its tile, never the front page: the matrix still
  // renders, as search skips a resource whose repo threw rather than answering 500 for the rest.
  test('a count that throws drops that tile only', async () => {
    const refusing = defineAdmin({
      entities: [widgets, vaults],
      db,
      resources: {
        ...COUNTED,
        home_vaults: {
          count: true,
          repo: {
            list: async () => [],
            find: async () => null,
            create: async () => expect.unreachable('no write'),
            update: async () => expect.unreachable('no write'),
            destroy: async () => expect.unreachable('no write'),
            count: () => Promise.reject(new TypeError('the store refused the count')),
          },
        },
      },
    });
    const html = await home(refusing, 'keeper');
    expect(stat(html, 'admin-count-home_widgets')).toBe('3');
    expect(stat(html, 'admin-count-home_vaults')).toBeUndefined();
    expect(html).toContain('admin:read + home_vaults:read');
  });

  test('counting reads no row, so it leaves the audit log alone', async () => {
    const before = (await open.audit.entries()).length;
    await home(open, 'keeper');
    expect((await open.audit.entries()).length).toBe(before);
  });

  // Every visit to `/admin` ran one full `count()` per listable resource, so any operator could
  // multiply database load by reloading the front page. A count is now asked for, per resource.
  test('a resource without count: true is not counted, and the home still renders', async () => {
    let counted = 0;
    const quiet = defineAdmin({
      entities: [widgets, vaults],
      db,
      resources: {
        home_widgets: { count: true },
        home_vaults: {
          repo: {
            list: async () => [],
            find: async () => null,
            create: async () => expect.unreachable('no write'),
            update: async () => expect.unreachable('no write'),
            destroy: async () => expect.unreachable('no write'),
            count: async () => {
              counted += 1;
              return 99;
            },
          },
        },
      },
    });
    const html = await home(quiet, 'keeper');
    expect(counted).toBe(0);
    expect(stat(html, 'admin-count-home_vaults')).toBeUndefined();
    expect(stat(html, 'admin-count-home_widgets')).toBe('3');
    // Uncounted is not unreachable: the permission matrix still lists the resource.
    expect(html).toContain('admin:read + home_vaults:read');
  });

  test('with no resource counted the home renders no KPI row at all', async () => {
    const plain = defineAdmin({ entities: [widgets, vaults], db });
    const html = await home(plain, 'keeper');
    expect(html).not.toContain('data-stat="admin-count-');
    expect(html).toContain('admin:read + home_widgets:read');
  });
});
