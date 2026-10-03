// `rows: (actor) => AdminFilter[]` — one declaration, and an actor sees only those rows on EVERY
// projection of the resource: the list, the search, the detail read, the lookup and the MCP tool.
// Five assertions, one per projection, over the same two actors and the same four rows.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';
import type { AdminActor } from './authz';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';
import type { AdminRouteResponse } from './screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');
const { adminDetail, adminList, adminUpdate } = await import('./crud');
const { adminSearch } = await import('./search');
const { adminLookup } = await import('./relations');
const { callAdminTool } = await import('./mcp');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();

const cases = entity('admin_scope_cases', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    region: text({ max: 8 }),
    token: text({ max: 64 }).sealed().nullable(),
  },
});

const db = database({ cases }, { driver: memoryDriver() });

let admin: AdminApp;
let resource: AdminResource;
beforeAll(() => {
  admin = defineAdmin({
    entities: [cases],
    db,
    resources: {
      admin_scope_cases: {
        // The second audience, declared once: a regional operator sees their region's rows, and
        // an actor with no region sees none — never all.
        rows: (actor) => [{ field: 'region', op: 'eq', value: actor.locale ?? '' }],
      },
    },
  });
  resource = admin.resource('admin_scope_cases');
});

registerCatalog('en', {
  'admin.admin_scope_cases.title': 'Cases',
  'admin.admin_scope_cases.field.title': 'Title',
  'admin.admin_scope_cases.field.region': 'Region',
});

const EU: AdminActor = { id: 'u-eu', roles: ['regional'], locale: 'eu' };
const US: AdminActor = { id: 'u-us', roles: ['regional'], locale: 'us' };
const ctxOf = (actor: AdminActor) => admin.ctx({ actor, requestId: 'row-scope' });

const ids = { eu: '', us: '' };

beforeAll(async () => {
  defineRoles({
    ...previousRoles,
    regional: {
      grants: ['admin:read', 'admin:write', 'admin_scope_cases:read', 'admin_scope_cases:write'],
    },
  });
  ids.eu = String((await db.cases.insert({ title: 'Alpha case', region: 'eu' })).id);
  await db.cases.insert({ title: 'Beta case', region: 'eu' });
  ids.us = String((await db.cases.insert({ title: 'Gamma case', region: 'us' })).id);
  await db.cases.insert({ title: 'Delta case', region: 'us' });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions);
  clearRegistry();
});

const titles = (rows: readonly AdminRow[]): readonly string[] =>
  rows.map((row) => String(row['title'])).sort();

describe('unit · an actor sees only rows(actor), on every projection', () => {
  test('1 · the list', async () => {
    const eu = await adminList(resource, ctxOf(EU));
    const us = await adminList(resource, ctxOf(US));
    expect(eu.ok && titles(eu.page.rows)).toEqual(['Alpha case', 'Beta case']);
    expect(us.ok && titles(us.page.rows)).toEqual(['Delta case', 'Gamma case']);
  });

  test('2 · the search', async () => {
    const found = await adminSearch({ term: 'case', resources: admin.resources, ctx: ctxOf(EU) });
    expect(found.hits.map((hit) => hit.label).sort()).toEqual(['Alpha case', 'Beta case']);
  });

  test('3 · the detail read — another audience’s row is not found, exactly as a missing one', async () => {
    const own = await adminDetail(resource, ctxOf(EU), ids.eu);
    expect(own.ok && own.row?.['title']).toBe('Alpha case');
    const other = await adminDetail(resource, ctxOf(EU), ids.us);
    expect(other.ok && other.row).toBeNull();
    // And a write cannot reach it either: the row the update would load is the same read.
    const write = await adminUpdate(resource, ctxOf(EU), ids.us, { title: 'Taken' });
    expect(write.ok === false && write.kind).toBe('missing');
    // The attempt is on the log: a write that did not happen is still something that was tried.
    expect(write.audit).toMatchObject({ outcome: 'failed', reason: 'admin.error.row-missing' });
    expect((await db.cases.where({ id: ids.us }).one())?.title).toBe('Gamma case');
  });

  test('4 · the lookup', async () => {
    const looked = await adminLookup(resource, ctxOf(US), { term: 'case' });
    expect(looked.ok && looked.options.map((option) => option.label).sort()).toEqual([
      'Delta case',
      'Gamma case',
    ]);
  });

  test('5 · the MCP list tool — and a `where` the agent sends narrows inside the scope, never out of it', async () => {
    const listed = await callAdminTool(admin, ctxOf(EU), 'admin.admin_scope_cases.list', {});
    const page = listed.ok ? (listed.data as { rows: readonly AdminRow[] }) : { rows: [] };
    expect(titles(page.rows)).toEqual(['Alpha case', 'Beta case']);

    const asked = await callAdminTool(admin, ctxOf(EU), 'admin.admin_scope_cases.list', {
      where: [{ field: 'title', value: 'Gamma' }],
    });
    expect(asked.ok && (asked.data as { rows: readonly AdminRow[] }).rows).toEqual([]);
    const read = await callAdminTool(admin, ctxOf(EU), 'admin.admin_scope_cases.read', {
      id: ids.us,
    });
    expect(read.ok && read.data).toBeNull();
  });
});

describe('unit · the mounted screens read through the same scope', () => {
  const ask = (
    actor: AdminActor,
    path: string,
  ): Promise<{ response: AdminRouteResponse; html: string }> =>
    runWithContext(
      createContext({ actor: userActor({ id: actor.id, roles: [...(actor.roles ?? [])] }) }),
      async () => {
        const url = `http://localhost${path}`;
        const matched = adminRouteMatch(admin, new URL(url).pathname);
        if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
        const response = await matched.route.respond({
          ctx: ctxOf(actor),
          params: matched.params,
          url,
          method: 'GET',
          form: null,
        });
        const html =
          response.kind === 'document'
            ? await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
            : '';
        return { response, html };
      },
    );

  test('the list page, and a 404 for a row outside it — detail and edit alike', async () => {
    const list = await ask(EU, '/admin/admin_scope_cases');
    expect(list.html).toContain('Alpha case');
    expect(list.html).not.toContain('Gamma case');
    for (const path of [
      `/admin/admin_scope_cases/${ids.us}`,
      `/admin/admin_scope_cases/${ids.us}/edit`,
    ]) {
      const answer = await ask(EU, path);
      expect({
        path,
        status: answer.response.kind === 'document' && answer.response.status,
      }).toEqual({ path, status: 404 });
      expect(answer.html).not.toContain('Gamma case');
    }
  });
});

describe('unit · a row scope is declared against real, readable columns', () => {
  test('a predicate on a sealed column is refused on the first read, by name', async () => {
    const sealed = defineAdmin({
      basePath: '/sealed-scope',
      entities: [cases],
      db,
      resources: { admin_scope_cases: { rows: () => [{ field: 'token', op: 'eq', value: 'x' }] } },
    });
    await expect(adminList(sealed.resource('admin_scope_cases'), ctxOf(EU))).rejects.toThrow(
      /rows: token eq" names a sealed column/,
    );
  });

  test('and one on a field that is not a column', async () => {
    const wrong = defineAdmin({
      basePath: '/wrong-scope',
      entities: [cases],
      db,
      resources: { admin_scope_cases: { rows: () => [{ field: 'nope', op: 'eq', value: 'x' }] } },
    });
    await expect(adminList(wrong.resource('admin_scope_cases'), ctxOf(EU))).rejects.toThrow(
      /names a field that is not a column \(this list answers: id, title, region\)/,
    );
  });
});
