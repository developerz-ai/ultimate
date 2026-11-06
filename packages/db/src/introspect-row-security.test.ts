// The catalog's half of row security: the policies on a table whose row security binds, as names,
// and never on a description nobody read the catalog for.

import { describe, expect, test } from 'bun:test';
import { recordingClient } from './fake';
import { buildSchema, findTable, introspectSchema } from './introspect';

const column = (table: string) => ({
  table_name: table,
  column_name: 'id',
  data_type: 'uuid',
  is_nullable: 'NO',
  column_default: null,
  ordinal_position: 1,
});

describe('policyNames', () => {
  test('per table, sorted; [] on a table with none; absent when the catalog was not asked', () => {
    const rows = [column('posts'), column('tags')];
    const policies = [
      { table_name: 'posts', policy_name: 'z_extra' },
      { table_name: 'posts', policy_name: 'ultimate_tenant' },
    ];
    const asked = buildSchema('public', [], rows, [], [], [], undefined, [], policies);
    expect(findTable(asked, 'posts')?.policyNames).toEqual(['ultimate_tenant', 'z_extra']);
    expect(findTable(asked, 'tags')?.policyNames).toEqual([]);
    expect(findTable(asked, 'posts')?.rowSecurity).toBeUndefined();
    const unasked = buildSchema('public', [], rows, [], []);
    expect(findTable(unasked, 'posts')).not.toHaveProperty('policyNames');
  });

  test('introspectSchema reads only the policies of an enabled AND forced table', async () => {
    const client = recordingClient();
    client.on(/information_schema\.columns/, { rows: [column('posts')] });
    client.on(/pg_policy/, { rows: [{ table_name: 'posts', policy_name: 'ultimate_tenant' }] });
    const schema = await introspectSchema({ client });
    expect(findTable(schema, 'posts')?.policyNames).toEqual(['ultimate_tenant']);
    const query = client.statements.find((statement) => statement.text.includes('pg_policy'));
    expect(query?.text).toContain('c.relrowsecurity and c.relforcerowsecurity');
  });
});
