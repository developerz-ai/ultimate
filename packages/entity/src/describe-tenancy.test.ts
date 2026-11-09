// Which physical column each tenant table is scoped by — what `x db gen` writes a row-security
// policy over. Read off the declaration, never inferred from a column's name a second time.

import { afterAll, describe, expect, test } from 'bun:test';
import { generateMigration } from '@ultimat3/db';
import { text, uuid } from './columns';
import { describeTenancy } from './describe-tenancy';
import { entity } from './entity';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

entity('dtn_posts', { columns: { id: uuid().primaryKey(), orgId: uuid().tenant() } });
entity('dtn_notes', {
  table: 'dtn_note_rows',
  tenant: 'workspaceId',
  columns: { id: uuid().primaryKey(), workspaceId: text().column('ws') },
});
const inferred = entity('dtn_inferred', {
  columns: { id: uuid().primaryKey(), orgId: uuid() },
});
const declaredTenant = entity('dtn_declared', {
  tenant: 'workspaceId',
  columns: { id: uuid().primaryKey(), workspaceId: text().column('ws') },
});
const marked = entity('dtn_marked', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant() },
});
const composite = entity('dtn_composite', {
  primaryKey: ['orgId', 'slug'],
  columns: { orgId: uuid(), slug: text() },
});
entity('dtn_plans', {
  shared: 'every tenant reads the one price list',
  columns: { id: uuid().primaryKey() },
});

describe('describeTenancy', () => {
  test('one row per tenant table: its physical table and column, never the property', () => {
    expect(describeTenancy().filter((row) => row.table.startsWith('dtn_'))).toEqual([
      { table: 'dtn_composite', column: 'org_id' },
      { table: 'dtn_declared', column: 'ws' },
      { table: 'dtn_inferred', column: 'org_id' },
      { table: 'dtn_marked', column: 'org_id' },
      { table: 'dtn_note_rows', column: 'ws' },
      { table: 'dtn_posts', column: 'org_id' },
    ]);
  });
});

/**
 * Every tenant read is `where org_id = $1 order by id`: indexed on `(tenant, pk)` it is an index
 * range scan (measured 1.5 ms at 500k rows); unindexed, a sequential scan (43.7 ms). Only
 * `.tenant()` used to set `index: true`, so an INFERRED tenant column had no index at all.
 */
describe('every tenant table is indexed on (tenant, primary key)', () => {
  const columnsOf = (description: ReturnType<typeof inferred.$describe>): string[][] =>
    description.indexes.map((index) => [...index.columns]);

  test.each([
    ['inferred orgId', inferred, ['org_id', 'id']],
    ['declared tenant key', declaredTenant, ['ws', 'id']],
    ['.tenant()', marked, ['org_id', 'id']],
  ] as const)('%s', (_name, subject, expected) => {
    const index = subject
      .$describe()
      .indexes.find((candidate) => candidate.columns[0] === expected[0]);
    expect(index).toMatchObject({ columns: expected, unique: false, concurrently: true });
    // The single-column `(org_id)` index the composite's prefix already serves is not built twice.
    expect(columnsOf(subject.$describe())).not.toContainEqual([expected[0]]);
  });

  test('a primary key that already leads with the tenant needs no second index', () => {
    expect(composite.$describe().indexes).toEqual([]);
  });

  test('an untenanted table gets none', () => {
    const plan = entity('dtn_untenanted', { columns: { id: uuid().primaryKey(), name: text() } });
    expect(plan.$describe().indexes).toEqual([]);
  });

  // `@ultimat3/db` derives a UNIQUE `(org_id, id)` on the target of a same-tenant reference
  // (`same-tenant.ts`); a second, non-unique `(org_id, id)` beside it is a duplicate index.
  test('a same-tenant reference target keeps only the derived unique key', () => {
    const boards = entity('dtn_boards', { columns: { id: uuid().primaryKey(), orgId: uuid() } });
    const cards = entity('dtn_cards', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid(),
        boardId: uuid().references(() => boards.id),
      },
    });
    expect(boards.$describe().indexes.map((index) => [...index.columns])).not.toContainEqual([
      'org_id',
      'id',
    ]);
    // End to end: the migration builds `(org_id, id)` once — the derived unique key.
    const up = generateMigration({
      entities: [boards.$describe(), cards.$describe()],
      name: 'same tenant',
      now: new Date('2026-11-09T00:00:00.000Z'),
    }).up;
    expect(up.match(/on "dtn_boards" \("org_id", "id"\)/g)).toHaveLength(1);
  });

  test('a declared index that starts with (tenant, pk) is the tenant index', () => {
    const lanes = entity('dtn_lanes', {
      columns: { id: uuid().primaryKey(), orgId: uuid(), name: text() },
      indexes: [{ on: ['orgId', 'id', 'name'] }],
    });
    expect(lanes.$describe().indexes.map((index) => [...index.columns])).toEqual([
      ['org_id', 'id', 'name'],
    ]);
  });

  test('a unique invariant over (tenant, pk) is the tenant index', () => {
    const pins = entity('dtn_pins', {
      columns: { id: uuid().primaryKey(), orgId: uuid() },
      invariants: (c) => [invariant('pins_tenant_key', c.unique(['orgId', 'id']))],
    });
    expect(pins.$describe().indexes).toEqual([]);
  });
});
