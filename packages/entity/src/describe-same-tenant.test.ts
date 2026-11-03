// When a `references()` is same-tenant, decided at describe time from the two bindings, and what the
// `crossTenant` option may say about it.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const orgs = entity('dst_orgs', { columns: { id: uuid().primaryKey() } });
const catalog = entity('dst_catalog', { columns: { id: uuid().primaryKey() } });

const posts = entity('dst_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
  },
});

const notePk = uuid().primaryKey();

const notes = entity('dst_notes', {
  tenant: 'workspaceId',
  columns: {
    id: notePk,
    workspaceId: uuid().column('ws_id'),
    postId: uuid().references(() => posts.id),
    parentId: uuid()
      .nullable()
      .references(() => notePk),
    catalogId: uuid().references(() => catalog.id),
    sharedId: uuid().references(() => posts.id, { crossTenant: 'shared catalog row' }),
    title: text({ max: 10 }),
  },
});

const columnOf = (name: string) =>
  notes.$describe().columns.find((column) => column.property === name);

describe('unit · resolving sameTenant', () => {
  test('both ends scoped: the two physical tenant columns, on the column and on the record', () => {
    const expected = { column: 'ws_id', targetColumn: 'org_id' };
    expect(columnOf('postId')?.sameTenant).toEqual(expected);
    const record = notes.$references?.().find((one) => one.property === 'postId');
    expect(record?.sameTenant).toEqual(expected);
  });

  test('a self-reference is composite', () => {
    expect(columnOf('parentId')?.sameTenant).toEqual({
      column: 'ws_id',
      targetColumn: 'ws_id',
    });
  });

  test('an edge to an untenanted root stays plain and carries no field', () => {
    const description = posts.$describe().columns.find((column) => column.property === 'orgId');
    expect(description?.references).toBe('dst_orgs.id');
    expect(Object.hasOwn(description ?? {}, 'sameTenant')).toBe(false);
    expect(Object.hasOwn(columnOf('catalogId') ?? {}, 'sameTenant')).toBe(false);
  });

  test('crossTenant is the escape: plain key, the reason stays out of the description', () => {
    const shared = columnOf('sharedId');
    expect(Object.hasOwn(shared ?? {}, 'sameTenant')).toBe(false);
    expect(JSON.stringify(shared)).not.toContain('shared catalog row');
  });

  test('the tenant column itself is never composite with itself', () => {
    const child = entity('dst_self_tenant', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid()
          .references(() => posts.orgId)
          .tenant(),
      },
    });
    expect(
      Object.hasOwn(
        child.$describe().columns.find((column) => column.property === 'orgId') ?? {},
        'sameTenant',
      ),
    ).toBe(false);
  });
});

describe('unit · refusing crossTenant', () => {
  const refused = (work: () => unknown): { code: string; cause: string; fix: string } => {
    try {
      work();
    } catch (error) {
      if (isUltimateError(error)) return { code: error.code, cause: error.message, fix: error.fix };
    }
    return expect.unreachable('the declaration is refused');
  };

  test('a blank reason, where the chain was written', () => {
    for (const reason of ['', '   ']) {
      const failure = refused(() => uuid().references(() => posts.id, { crossTenant: reason }));
      expect(failure.code).toBe('X_INVARIANT_VIOLATED');
      expect(failure.fix).toContain("crossTenant: '");
    }
  });

  test('on an edge that was never same-tenant: a reason for nothing', () => {
    const child = entity('dst_pointless', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid().tenant(),
        rootId: uuid().references(() => catalog.id, { crossTenant: 'shared' }),
      },
    });
    const failure = refused(() => child.$describe());
    expect(failure.code).toBe('X_INVARIANT_VIOLATED');
    expect(failure.cause).toContain('dst_pointless.rootId');
    expect(failure.fix).toContain('references(() => ');
  });
});

describe('unit · a reference names the physical table', () => {
  const named = entity('DstNamed', {
    table: 'dst_named_table',
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant() },
  });
  const child = entity('dst_named_child', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      namedId: uuid().references(() => named.id),
    },
  });

  test('the string a migration reads is the table; the record a relation reads keeps the name', () => {
    const column = child.$describe().columns.find((one) => one.property === 'namedId');
    expect(column?.references).toBe('dst_named_table.id');
    const record = child.$references().find((one) => one.property === 'namedId');
    expect(record?.targetEntity).toBe('DstNamed');
    expect(record?.targetTable).toBe('dst_named_table');
  });
});
