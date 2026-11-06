// `X_DB_ROW_SECURITY_DRIFT`, both readings: the flag against what the migrations recorded (the
// gate, no database), and the recorded policy against the live catalog (after `x db migrate`).

import { describe, expect, test } from 'bun:test';
import { diffSchema, driftError } from './drift';
import { rowSecurityDifferences, rowSecurityDrift } from './drift-row-security';
import type { EntityDescriptionLike } from './entity-shape';
import type { SchemaDescription, TableDescription } from './introspect';
import { ROW_SECURITY_POLICY } from './row-security';

const col = (column: string, primaryKey = false) => ({
  property: column,
  column,
  kind: 'uuid',
  notNull: true,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});
const posts: EntityDescriptionLike = {
  name: 'posts',
  table: 'posts',
  primaryKey: ['id'],
  columns: [col('id', true), col('org_id')],
  indexes: [],
};
const tenants = [{ table: 'posts', column: 'org_id' }];

const table = (overrides: Partial<TableDescription> = {}): TableDescription => ({
  schema: 'public',
  name: 'posts',
  columns: [],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  ...overrides,
});
const schema = (one: TableDescription): SchemaDescription => ({ tables: [one] });

describe('rowSecurityDifferences · the flag against the migrations', () => {
  test('on and unrecorded is missing; on and recorded is agreement', () => {
    const on = { enabled: true, tenants };
    expect(rowSecurityDifferences([posts], schema(table()), on)).toEqual([
      { table: 'posts', direction: 'missing' },
    ]);
    expect(rowSecurityDifferences([posts], schema(table({ rowSecurity: true })), on)).toEqual([]);
  });

  test('off and recorded is stray; off and unrecorded is agreement', () => {
    const off = { enabled: false, tenants };
    expect(rowSecurityDifferences([posts], schema(table({ rowSecurity: true })), off)).toEqual([
      { table: 'posts', direction: 'stray' },
    ]);
    expect(rowSecurityDifferences([posts], schema(table()), off)).toEqual([]);
  });

  test('raised as X_DB_ROW_SECURITY_DRIFT, its fix the generation it waits on', () => {
    const error = rowSecurityDrift({ table: 'posts', direction: 'missing' });
    expect(error.code).toBe('X_DB_ROW_SECURITY_DRIFT');
    expect(error.fix).toBe('x db gen "row security"');
    expect(error.cause).toContain('"posts"');
  });
});

describe('compareRowSecurity · the record against the live catalog', () => {
  const recorded = schema(table({ rowSecurity: true }));

  test('the policy present on a forced table is agreement; nobody asked is silence', () => {
    expect(diffSchema(schema(table({ policyNames: [ROW_SECURITY_POLICY] })), recorded).ok).toBe(
      true,
    );
    expect(diffSchema(schema(table()), recorded).ok).toBe(true);
  });

  test('recorded and absent (or unforced: no names) is missing-row-security, its own code', () => {
    const report = diffSchema(schema(table({ policyNames: [] })), recorded);
    expect(report.differences.map((d) => d.kind)).toEqual(['missing-row-security']);
    const [difference] = report.differences;
    if (difference === undefined) expect.unreachable('a missing policy was not reported');
    expect(driftError(difference).code).toBe('X_DB_ROW_SECURITY_DRIFT');
    expect(difference.fix).toStartWith(`grep -n 'on "posts"' packages/db/migrations/*.sql`);
  });

  test('present and unrecorded is unexpected-row-security', () => {
    const live = schema(table({ policyNames: [ROW_SECURITY_POLICY] }));
    const report = diffSchema(live, schema(table()));
    expect(report.differences.map((d) => d.kind)).toEqual(['unexpected-row-security']);
  });
});
