// Single responsibility: issue #340's exact shape, end to end — a managed Postgres carrying an
// extension in `public` must produce ZERO drift findings, while a table nobody declared must STILL
// be reported. Split from `drift.test.ts` for the line ceiling; it is the only file here that
// drives `introspect()` and `diffSchema()` together, because the fix is in the first and the
// symptom was in the second.

import { describe, expect, test } from 'bun:test';
import { appTables, diffSchema } from './drift';
import { createRecordingClient } from './fake';
import { introspect, type SchemaDescription } from './introspect';

/** One column row, the only shape `information_schema.columns` contributes to a table's identity. */
const column = (table: string, name: string) => ({
  table_name: table,
  column_name: name,
  data_type: 'text',
  is_nullable: 'YES',
  column_default: null,
  ordinal_position: 1,
});

/** What the newest migration's snapshot declares: one app table, nothing else. */
const DECLARED: SchemaDescription = {
  tables: [
    {
      schema: 'public',
      name: 'posts',
      columns: [{ name: 'id', dataType: 'text', nullable: true, default: null, position: 1 }],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

describe('drift against a database carrying an extension in `public` (issue #340)', () => {
  test('an extension-owned relation is invisible to the audit, so the deploy is not refused', async () => {
    const client = createRecordingClient();
    // The CNPG/RDS/Supabase shape: `create extension pg_stat_statements` in `public`, so the
    // extension's view and its companion table sit beside the app's tables in every database.
    client.on(/information_schema\.columns/, {
      rows: [
        column('posts', 'id'),
        column('pg_stat_statements', 'query'),
        column('pg_stat_statements_info', 'dealloc'),
      ],
    });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });
    // What `pg_depend` answers: both relations carry a `deptype = 'e'` row. The companion table is
    // a real `relkind = 'r'` table, so only the ownership rule can exclude it — which is why a
    // "views are not app schema" rule alone would still refuse every `postgis` deploy.
    client.on(/pg_depend/, {
      rows: [{ name: 'pg_stat_statements' }, { name: 'pg_stat_statements_info' }],
    });

    const live = await introspect({ client });
    const report = diffSchema(appTables(live), DECLARED);

    expect(live.tables.map((t) => t.name)).toEqual(['posts']);
    expect(report.differences).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('a table nobody declared is still `unexpected-table` — the audit keeps its teeth', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, {
      rows: [column('posts', 'id'), column('scratch', 'id')],
    });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });
    // `scratch` was created by hand: no extension owns it, so it is not on this list.
    client.on(/pg_depend/, { rows: [] });

    const live = await introspect({ client });
    const report = diffSchema(appTables(live), DECLARED);

    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      {
        kind: 'unexpected-table',
        table: 'scratch',
        column: null,
        cause: 'table "scratch" is not present in any migration',
        fix: 'x db gen "add scratch"',
      },
    ]);
  });

  test('an explicit `exclude` cannot bring an extension-owned relation back into the audit', async () => {
    const client = createRecordingClient();
    client.on(/information_schema\.columns/, {
      rows: [column('posts', 'id'), column('spatial_ref_sys', 'srid')],
    });
    client.on(/pg_index/, { rows: [] });
    client.on(/pg_constraint/, { rows: [] });
    client.on(/pg_depend/, { rows: [{ name: 'spatial_ref_sys' }] });

    // The caller replaces the `x_migrations` default; the derived set is never a caller's to
    // override, because an extension's relation is not app schema in any deployment.
    const live = await introspect({ client, exclude: ['something_else'] });

    expect(live.tables.map((t) => t.name)).toEqual(['posts']);
  });
});
