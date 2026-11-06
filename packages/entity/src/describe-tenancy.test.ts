// Which physical column each tenant table is scoped by — what `x db gen` writes a row-security
// policy over. Read off the declaration, never inferred from a column's name a second time.

import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { describeTenancy } from './describe-tenancy';
import { entity } from './entity';
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
entity('dtn_plans', {
  shared: 'every tenant reads the one price list',
  columns: { id: uuid().primaryKey() },
});

describe('describeTenancy', () => {
  test('one row per tenant table: its physical table and column, never the property', () => {
    expect(describeTenancy().filter((row) => row.table.startsWith('dtn_'))).toEqual([
      { table: 'dtn_note_rows', column: 'ws' },
      { table: 'dtn_posts', column: 'org_id' },
    ]);
  });
});
