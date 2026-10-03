// Scopes: named predicates drawn as tabs. The default one is what a bare list URL reads; a count
// is read for the scopes that asked for one and for no other, through `AdminRepo.count`; and a
// scope is declared against real, readable columns or the admin does not boot.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  boolean,
  clearRegistry,
  database,
  entity,
  enumerated,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';
import type { AdminActor } from './authz';
import type { CrudCtx } from './crud';
import type { AdminFilter, AdminRepo, AdminRow } from './registry';
import type { AdminResource } from './resource';

const { defineAdmin } = await import('./admin');
const { adminList } = await import('./crud');
const { scopeCounts } = await import('./list-scope');
const { adminResource } = await import('./resource');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const orders = entity('admin_tab_orders', {
  columns: {
    id: uuid().primaryKey(),
    reference: text({ max: 40 }),
    status: enumerated(['open', 'paid', 'void']).default('open'),
    flagged: boolean().default(false),
    assignee: text({ max: 40 }).nullable(),
    cardToken: text({ max: 64 }).sealed().nullable(),
  },
});

const db = database({ orders }, { driver: memoryDriver() });

const SCOPES = {
  open: { where: [{ field: 'status', op: 'eq', value: 'open' }], default: true, count: true },
  paid: { where: [{ field: 'status', op: 'eq', value: 'paid' }] },
  mine: {
    where: (actor: AdminActor): readonly AdminFilter[] => [
      { field: 'assignee', op: 'eq', value: actor.id },
    ],
    count: true,
  },
} as const;

let admin: AdminApp;
let ctx: CrudCtx;
let resource: AdminResource;
beforeAll(() => {
  admin = defineAdmin({
    entities: [orders],
    db,
    resources: { admin_tab_orders: { scopes: SCOPES } },
  });
  ctx = admin.ctx({ actor: ANA, requestId: 'scopes' });
  resource = admin.resource('admin_tab_orders');
  repo = resource.repo ?? expect.unreachable('the resource has a repo');
});
/** The repo `defineAdmin` bound from the handle — every resource it builds has one. */
let repo: AdminRepo<AdminRow>;

const ANA: AdminActor = { id: 'ana', roles: ['clerk'] };

beforeAll(async () => {
  defineRoles({ ...previousRoles, clerk: { grants: ['admin:read', 'admin_tab_orders:read'] } });
  await db.orders.insert({ reference: 'A-1', assignee: 'ana' });
  await db.orders.insert({ reference: 'A-2', assignee: 'bo' });
  await db.orders.insert({ reference: 'A-3', status: 'paid', assignee: 'ana' });
  await db.orders.insert({ reference: 'A-4', status: 'void' });
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

const references = (rows: readonly AdminRow[]): readonly string[] =>
  rows.map((row) => String(row['reference'])).sort();

describe('unit · the default scope is what a bare list reads', () => {
  test('no scope named: the default one is applied, and reported', async () => {
    const result = await adminList(resource, ctx);
    expect(result.ok && result.scope?.name).toBe('open');
    expect(result.ok && references(result.page.rows)).toEqual(['A-1', 'A-2']);
  });

  test('a named scope replaces it; an actor-dependent one is asked with the actor', async () => {
    const paid = await adminList(resource, ctx, { scope: 'paid' });
    expect(paid.ok && references(paid.page.rows)).toEqual(['A-3']);
    const mine = await adminList(resource, ctx, { scope: 'mine' });
    expect(mine.ok && references(mine.page.rows)).toEqual(['A-1', 'A-3']);
  });

  test('a scope and a filter are a conjunction', async () => {
    const result = await adminList(resource, ctx, {
      scope: 'mine',
      filters: [{ field: 'status', op: 'eq', value: 'paid' }],
    });
    expect(result.ok && references(result.page.rows)).toEqual(['A-3']);
  });

  test('`scope: null` is no scope at all — what a lookup asks, never what a URL can', async () => {
    const result = await adminList(resource, ctx, { scope: null });
    expect(result.ok && result.scope).toBeNull();
    expect(result.ok && references(result.page.rows)).toEqual(['A-1', 'A-2', 'A-3', 'A-4']);
  });

  test('a resource with scopes and NO default reads every row on its bare URL', async () => {
    const open = adminResource(orders, { repo, scopes: { paid: SCOPES.paid } });
    const result = await adminList(open, ctx);
    expect(result.ok && result.scope).toBeNull();
    expect(result.ok && result.page.rows).toHaveLength(4);
  });

  test('an unknown scope is refused, naming the declared ones', async () => {
    await expect(adminList(resource, ctx, { scope: 'archived' })).rejects.toThrow(
      /"scope=archived" is not a scope of this resource \(this list answers: scope=open, scope=paid, scope=mine\)/,
    );
  });
});

describe('unit · counts are read only where a scope declared one', () => {
  test('one count per `count: true` scope, through AdminRepo.count — and none for the rest', async () => {
    const counted: (readonly AdminFilter[])[] = [];
    const spying: AdminRepo<AdminRow> = {
      ...repo,
      count: async (where) => {
        counted.push(where ?? []);
        return repo.count?.(where) ?? 0;
      },
    };
    const spied = adminResource(orders, { repo: spying, scopes: SCOPES });

    const counts = await scopeCounts(spied, ANA);
    expect([...counts]).toEqual([
      ['open', 2],
      ['mine', 2],
    ]);
    // `paid` set no `count`, so no query was issued for it.
    expect(counted).toHaveLength(2);
    expect(counted[1]).toEqual([{ field: 'assignee', op: 'eq', value: 'ana' }]);
  });

  test('a resource with no counted scope asks the repo nothing', async () => {
    let asked = 0;
    const quiet = adminResource(orders, {
      repo: {
        ...repo,
        count: async () => {
          asked += 1;
          return 0;
        },
      },
      scopes: { paid: SCOPES.paid },
    });
    expect((await scopeCounts(quiet, ANA)).size).toBe(0);
    expect(asked).toBe(0);
  });

  test('a row scope rides the count: a tab never counts rows its reader cannot list', async () => {
    const scoped = adminResource(orders, {
      repo,
      scopes: SCOPES,
      rows: (actor) => [{ field: 'assignee', op: 'eq', value: actor.id }],
    });
    expect((await scopeCounts(scoped, ANA)).get('open')).toBe(1);
  });
});

describe('unit · a scope is refused where it is declared', () => {
  const declare = (scopes: Parameters<typeof adminResource>[1]): (() => unknown) => {
    return () => adminResource(orders, { ...scopes, repo });
  };

  test('two defaults', () => {
    expect(
      declare({ scopes: { open: SCOPES.open, paid: { ...SCOPES.paid, default: true } } }),
    ).toThrow(/marks more than one scope `default: true`/);
  });

  test('a predicate on a sealed column, or on a field that is not a column', () => {
    expect(
      declare({
        scopes: { carded: { where: [{ field: 'cardToken', op: 'is-null', value: false }] } },
      }),
    ).toThrow(/names a sealed column, which no predicate can read/);
    expect(
      declare({ scopes: { odd: { where: [{ field: 'colour', op: 'eq', value: 'red' }] } } }),
    ).toThrow(/names a field that is not a column/);
  });

  test('`count: true` over a repo with no count()', () => {
    const { count: _dropped, ...countless } = repo;
    expect(() => adminResource(orders, { repo: countless, scopes: { open: SCOPES.open } })).toThrow(
      /asks for a count, and the repo this resource reads through has no count\(\)/,
    );
  });

  test('every one of them is X_ADMIN_FILTER_INVALID', () => {
    expect(
      declare({ scopes: { odd: { where: [{ field: 'colour', op: 'eq', value: 'red' }] } } }),
    ).toThrow(/X_ADMIN_FILTER_INVALID/);
  });
});
