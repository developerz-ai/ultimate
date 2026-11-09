// The admin under a routed locale: a request to `/es/admin/…` is matched on the unprefixed path
// (the host strips it), and every link, form action and redirect the screen writes keeps `/es`.
// An unprefixed `href="/admin/…"` sends each click back to the default locale.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { configureLocales, resetLocaleConfig, unlocalizedPath } from '@ultimat3/i18n';
import { memoryJobDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminRouteResponse } from './screen-frame';

// After `@ultimat3/render/server` installs its `.tsx` loader, as `mounted-screens.test.ts` does.
const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const parts = entity('admin_locale_parts', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }), stock: integer() },
});
const db = database({ parts }, { driver: memoryDriver() });
const admin = defineAdmin({ entities: [parts], db });
const BASE = '/admin/admin_locale_parts';
let rowId = '';

beforeAll(async () => {
  configureLocales({ supported: ['en', 'es'], fallback: 'en' });
  setJobDriver(memoryJobDriver());
  defineRoles({
    ...previousRoles,
    operator: {
      grants: [
        'admin:read',
        'admin:write',
        'admin_locale_parts:read',
        'admin_locale_parts:write',
        'job:read',
        'audit:read',
      ],
    },
  });
  rowId = String((await db.parts.insert({ title: 'Sprocket', stock: 7 })).id);
});

afterAll(() => {
  resetJobDriver();
  resetLocaleConfig();
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

/** One request as a host answers it: matched on the unprefixed path, handed the URL as sent. */
const ask = (path: string, form?: Readonly<Record<string, unknown>>, httpBase = '') =>
  runWithContext(
    ctxOf({ actor: userActor({ id: 'u-op', roles: ['operator'] }), tz: 'UTC', locale: 'es' }),
    async (): Promise<{ response: AdminRouteResponse; html: string }> => {
      const url = `http://localhost${httpBase}${path}`;
      // The route path a host matches on: its own base path and the locale prefix removed.
      const matched = adminRouteMatch(
        admin,
        unlocalizedPath(new URL(`http://localhost${path}`).pathname),
      );
      if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
      const response = await matched.route.respond({
        ctx: await admin.requestCtx(new Request(url)),
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

/** Every `href=` and `action=` the page writes that is a path on this host. */
const paths = (html: string): string[] =>
  [...html.matchAll(/(?:href|action)="(\/[^"]*)"/g)].map((found) => found[1] ?? '');

describe('unit · the admin under a routed locale keeps the locale in every link', () => {
  test('the list: rows, nav, search and the way home all stay under /es', async () => {
    const { html } = await ask(`/es${BASE}`);
    expect(html).toContain(`href="/es${BASE}/${rowId}"`);
    expect(html).toContain('action="/es/admin/search"');
    expect(html).toContain('href="/es/"');
    const unprefixed = paths(html).filter((path) => !path.startsWith('/es/'));
    expect(unprefixed).toEqual([]);
  });

  test('the detail stays under /es, and the default locale is still unprefixed', async () => {
    const { html } = await ask(`/es${BASE}/${rowId}`);
    expect(paths(html).filter((path) => !path.startsWith('/es/'))).toEqual([]);
    const plain = await ask(`${BASE}/${rowId}`);
    expect(plain.html).toContain(`href="${BASE}/${rowId}/edit"`);
    expect(paths(plain.html).some((path) => path.startsWith('/es/'))).toBe(false);
  });

  test('a posted create redirects to the row under /es', async () => {
    const { response } = await ask(`/es${BASE}/new`, { title: 'Widget', stock: '3' });
    const [made] = await db.parts.where({ title: 'Widget' }).all();
    expect(response).toEqual({ kind: 'redirect', location: `/es${BASE}/${String(made?.id)}` });
  });

  test('the dashboard, jobs, search and audit screens stay under /es too', async () => {
    for (const path of ['/admin', '/admin/jobs', '/admin/search?term=Spro', '/admin/audit']) {
      const { response, html } = await ask(`/es${path}`);
      expect(response.kind === 'document' ? response.status : response.location).toBe(200);
      expect({ path, unprefixed: paths(html).filter((one) => !one.startsWith('/es/')) }).toEqual({
        path,
        unprefixed: [],
      });
    }
  });

  test('behind an HTTP base path the locale is still found, and the links keep both', async () => {
    const { html } = await ask(`/es${BASE}/${rowId}`, undefined, '/myapp');
    const links = paths(html).filter((one) => one.includes('/admin'));
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((one) => !one.startsWith('/myapp/es/admin'))).toEqual([]);
    expect(html).toContain('href="/myapp/es/"');
  });

  test('behind an HTTP base path with no locale, links and home keep the base path', async () => {
    const { html } = await ask(`${BASE}/${rowId}`, undefined, '/myapp');
    expect(paths(html).filter((one) => !one.startsWith('/myapp/'))).toEqual([]);
    expect(html).toContain(`href="/myapp${BASE}/${rowId}/edit"`);
    expect(html).toContain('href="/myapp/"');
  });
});
