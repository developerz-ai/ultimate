// A row scope is authorization, so a declared `contains` keeps the exact, case-sensitive meaning it
// shipped with — on the read and on the write — while the operator's search box and filters fold
// case. `contains: 'Acme'` never admits 'acme corp', however the operator spells the search.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';
import type { AdminActor } from './authz';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';
import { ROW_OUT_OF_SCOPE_REASON } from './row-scope-write';

const { defineAdmin } = await import('./admin');
const { adminCreate, adminList } = await import('./crud');
const { adminSearch } = await import('./search');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const clients = entity('admin_scope_case_clients', {
  columns: { id: uuid().primaryKey(), company: text({ max: 80 }) },
});
const db = database({ clients }, { driver: memoryDriver() });

let admin: AdminApp;
let resource: AdminResource;
const ACME: AdminActor = { id: 'u-acme', roles: ['acme-desk'] };
const ctxOf = (actor: AdminActor) => admin.ctx({ actor, requestId: 'row-scope-case' });
const companies = (rows: readonly AdminRow[]): readonly string[] =>
  rows.map((row) => String(row['company'])).sort();

beforeAll(async () => {
  admin = defineAdmin({
    basePath: '/scope-case',
    entities: [clients],
    db,
    resources: {
      admin_scope_case_clients: {
        rows: () => [{ field: 'company', op: 'contains', value: 'Acme' }],
      },
    },
  });
  resource = admin.resource('admin_scope_case_clients');
  defineRoles({
    ...previousRoles,
    'acme-desk': {
      grants: [
        'admin:read',
        'admin:write',
        'admin_scope_case_clients:read',
        'admin_scope_case_clients:write',
      ],
    },
  });
  await db.clients.insert({ company: 'Acme Ltd' });
  await db.clients.insert({ company: 'acme corp' });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

describe('unit · a row scope’s `contains` is case-sensitive; the search inside it is not', () => {
  test('the list admits the exact-case row only', async () => {
    const listed = await adminList(resource, ctxOf(ACME));
    expect(listed.ok && companies(listed.page.rows)).toEqual(['Acme Ltd']);
  });

  test('a lower-case search finds the in-scope row and never the other', async () => {
    const found = await adminSearch({ term: 'acme', resources: admin.resources, ctx: ctxOf(ACME) });
    expect(found.hits.map((hit) => hit.label)).toEqual(['Acme Ltd']);
  });

  test('a create the scope’s exact-case `contains` refuses is not written', async () => {
    const result = await adminCreate(resource, ctxOf(ACME), { company: 'acme two' });
    expect(result.ok === false && result.audit?.reason).toBe(ROW_OUT_OF_SCOPE_REASON);
    expect(await db.clients.count()).toBe(2);
  });
});
