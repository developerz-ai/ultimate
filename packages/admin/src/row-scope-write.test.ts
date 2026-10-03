// `rows` narrows a WRITE's result as well as every read: a row-scoped actor may not create a row
// outside its own scope, and may not move one out of it. Refused before the repo is asked to write
// — nothing lands, and the attempt is on the log as a denial.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  database,
  entity,
  integer,
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
import type { AdminResource } from './resource';
import { outsideRowScope, ROW_OUT_OF_SCOPE_REASON } from './row-scope-write';

const { defineAdmin } = await import('./admin');
const { adminCreate, adminUpdate } = await import('./crud');
const { callAdminTool } = await import('./mcp');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const cases = entity('admin_scope_writes', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    region: text({ max: 8 }),
    weight: integer().default(0),
  },
});

const db = database({ cases }, { driver: memoryDriver() });

let admin: AdminApp;
let resource: AdminResource;
beforeAll(() => {
  admin = defineAdmin({
    basePath: '/scope-writes',
    entities: [cases],
    db,
    resources: {
      admin_scope_writes: {
        rows: (actor) => [{ field: 'region', op: 'eq', value: actor.locale ?? '' }],
      },
    },
  });
  resource = admin.resource('admin_scope_writes');
});

const EU: AdminActor = { id: 'u-eu', roles: ['scope-writer'], locale: 'eu' };
const ctxOf = (actor: AdminActor) => admin.ctx({ actor, requestId: 'row-scope-write' });
const count = (): Promise<number> => db.cases.count();

let euId = '';

beforeAll(async () => {
  defineRoles({
    ...previousRoles,
    'scope-writer': {
      grants: ['admin:read', 'admin:write', 'admin_scope_writes:read', 'admin_scope_writes:write'],
    },
  });
  euId = String((await db.cases.insert({ title: 'Alpha', region: 'eu', weight: 1 })).id);
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

describe('unit · a write’s resulting row satisfies the actor’s row scope', () => {
  test('a create OUTSIDE the scope is refused, writes nothing, and is audited as a denial', async () => {
    const before = await count();
    const result = await adminCreate(resource, ctxOf(EU), { title: 'Smuggled', region: 'us' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe('denied');
    expect(result.audit).toMatchObject({
      operation: 'create',
      outcome: 'denied',
      reason: ROW_OUT_OF_SCOPE_REASON,
    });
    expect(await count()).toBe(before);
  });

  test('a create INSIDE the scope is written', async () => {
    const result = await adminCreate(resource, ctxOf(EU), { title: 'Mine', region: 'eu' });
    expect(result.ok && result.row?.['region']).toBe('eu');
  });

  test('an update that would MOVE the row out of the scope is refused and changes nothing', async () => {
    const result = await adminUpdate(resource, ctxOf(EU), euId, { region: 'us', title: 'Moved' });
    expect(result.ok === false && result.kind).toBe('denied');
    expect(result.audit).toMatchObject({
      operation: 'update',
      entityId: euId,
      outcome: 'denied',
      reason: ROW_OUT_OF_SCOPE_REASON,
    });
    const stored = await db.cases.where({ id: euId }).one();
    expect({ region: stored?.region, title: stored?.title }).toEqual({
      region: 'eu',
      title: 'Alpha',
    });
  });

  test('an update that leaves the scoped column alone is written', async () => {
    const result = await adminUpdate(resource, ctxOf(EU), euId, { title: 'Alpha, renamed' });
    expect(result.ok && result.row?.['title']).toBe('Alpha, renamed');
  });

  test('the MCP create tool is refused by the same check', async () => {
    const before = await count();
    const called = await callAdminTool(admin, ctxOf(EU), 'admin.admin_scope_writes.create', {
      title: 'Agent smuggled',
      region: 'us',
    });
    expect(called).toMatchObject({ ok: false, error: 'X_ADMIN_DENIED' });
    expect(await count()).toBe(before);
  });

  test('an actor with no scope predicate writes any row', async () => {
    const open = defineAdmin({ basePath: '/scope-writes-open', entities: [cases], db });
    const result = await adminCreate(
      open.resource('admin_scope_writes'),
      open.ctx({ actor: EU, requestId: 'open' }),
      { title: 'Anywhere', region: 'us' },
    );
    expect(result.ok).toBe(true);
  });
});

describe('unit · outsideRowScope decides what it can decide exactly, and refuses the rest', () => {
  const candidate = {
    region: 'eu',
    weight: 5,
    title: 'Alpha',
    at: new Date('2026-01-02T00:00:00Z'),
  };
  const outside = (filter: Parameters<typeof outsideRowScope>[1][number]): boolean =>
    outsideRowScope(candidate, [filter]) !== null;

  test('eq, neq, in and is-null', () => {
    expect(outside({ field: 'region', op: 'eq', value: 'eu' })).toBe(false);
    expect(outside({ field: 'region', op: 'eq', value: 'us' })).toBe(true);
    expect(outside({ field: 'region', op: 'neq', value: 'us' })).toBe(false);
    expect(outside({ field: 'region', op: 'neq', value: 'eu' })).toBe(true);
    expect(outside({ field: 'region', op: 'in', value: ['us', 'eu'] })).toBe(false);
    expect(outside({ field: 'region', op: 'in', value: ['us'] })).toBe(true);
    expect(outside({ field: 'missing', op: 'is-null', value: true })).toBe(false);
    expect(outside({ field: 'region', op: 'is-null', value: true })).toBe(true);
    expect(outside({ field: 'region', op: 'is-null', value: false })).toBe(false);
    // SQL's three-valued logic: a NULL is neither equal nor unequal to anything.
    expect(outside({ field: 'missing', op: 'eq', value: 'eu' })).toBe(true);
    expect(outside({ field: 'missing', op: 'neq', value: 'eu' })).toBe(true);
  });

  test('ordering over numbers and instants, and contains over text', () => {
    expect(outside({ field: 'weight', op: 'gt', value: 4 })).toBe(false);
    expect(outside({ field: 'weight', op: 'gt', value: 5 })).toBe(true);
    expect(outside({ field: 'weight', op: 'gte', value: 5 })).toBe(false);
    expect(outside({ field: 'weight', op: 'lt', value: 5 })).toBe(true);
    expect(outside({ field: 'weight', op: 'lte', value: 5 })).toBe(false);
    expect(outside({ field: 'at', op: 'gte', value: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(outside({ field: 'at', op: 'lt', value: '2026-01-01T00:00:00.000Z' })).toBe(true);
    expect(outside({ field: 'title', op: 'contains', value: 'lph' })).toBe(false);
    expect(outside({ field: 'title', op: 'contains', value: 'LPH' })).toBe(true);
  });

  test('an ordering over TEXT is a collation’s to decide, so the write is refused', () => {
    expect(outsideRowScope(candidate, [{ field: 'title', op: 'gt', value: 'A' }])).toMatchObject({
      field: 'title',
      decidable: false,
    });
  });

  test('the first predicate the row fails is the one named', () => {
    expect(
      outsideRowScope(candidate, [
        { field: 'region', op: 'eq', value: 'eu' },
        { field: 'weight', op: 'lt', value: 2 },
      ]),
    ).toEqual({ field: 'weight', op: 'lt', decidable: true });
  });
});
