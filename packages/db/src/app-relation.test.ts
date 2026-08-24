// Single responsibility: pin the predicate `nonAppRelations()` sends. A recording client cannot
// evaluate SQL, so what is asserted here is the SHAPE of the rule — ownership read out of
// `pg_depend`, never a name — plus the fold of its rows. Whether Postgres agrees is
// `introspect-embedded.test.ts`, against a real catalog.

import { describe, expect, test } from 'bun:test';
import { nonAppRelations } from './app-relation';
import { createRecordingClient } from './fake';

const textOf = (client: ReturnType<typeof createRecordingClient>): string =>
  client.texts.find((text) => text.includes('pg_class')) ?? '';

describe('nonAppRelations', () => {
  test('answers the names the catalog returned, in the order it returned them', async () => {
    const client = createRecordingClient();
    client.on(/pg_depend/, { rows: [{ name: 'pg_stat_statements' }, { name: 'spatial_ref_sys' }] });

    expect(await nonAppRelations(client, 'public')).toEqual([
      'pg_stat_statements',
      'spatial_ref_sys',
    ]);
  });

  test('a catalog with no extension and no view answers nothing, not `undefined`', async () => {
    const client = createRecordingClient();
    expect(await nonAppRelations(client, 'public')).toEqual([]);
  });

  test('the schema is bound, never spliced — one query, one parameter', async () => {
    const client = createRecordingClient();
    await nonAppRelations(client, 'tenant_a');

    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]?.values).toEqual(['tenant_a']);
    expect(textOf(client)).not.toContain('tenant_a');
  });

  test('ownership is read out of `pg_depend`, never guessed from a name', async () => {
    const client = createRecordingClient();
    await nonAppRelations(client, 'public');
    const text = textOf(client);

    // The whole point of issue #340's fix: an extension may install a relation under ANY name, so
    // a `like 'pg_%'` rule covers `pg_stat_statements` and misses `spatial_ref_sys`.
    expect(text).not.toContain('like');
    expect(text).toContain('pg_depend');
    expect(text).toContain("d.deptype = 'e'");
    expect(text).toContain("d.classid = 'pg_class'::regclass");
    expect(text).toContain("d.refclassid = 'pg_extension'::regclass");
  });

  test('a relation that is not a table is disqualified whoever created it', async () => {
    const client = createRecordingClient();
    await nonAppRelations(client, 'public');
    const text = textOf(client);

    // A view reaches `information_schema.columns` while the index query fences on `relkind = 'r'`
    // — so it arrived as a table with no primary key and no indexes, which cannot be true.
    expect(text).toContain("c.relkind in ('v', 'm', 'f')");
    // Ordinary and partitioned tables are the app's; they leave only by extension ownership.
    expect(text).toContain("c.relkind in ('r', 'p', 'v', 'm', 'f')");
  });
});
