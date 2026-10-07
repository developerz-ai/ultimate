// Single responsibility: `refuseDependentViews`' catalog read against the real embedded database.
// The pairing is filtered in JS and the fakes in `dependent-view.test.ts` pin that; only a server
// can say which RELATION a bare table name in a migration means when two schemas hold one each.

import { afterAll, describe, expect, test } from 'bun:test';
import { refuseDependentViews } from './dependent-view';
import { pgliteClient } from './pglite';
import { raw } from './sql';
import { statementsOf } from './statement-split';

describe('refuseDependentViews · the real embedded database', () => {
  const PGLITE_BOOT_MS = 30_000;
  const client = pgliteClient();
  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const RETYPE = 'alter table dv_docs alter column status type integer using 0;';

  afterAll(async () => {
    await client.close();
  });

  test(
    'a view over a same-named table in ANOTHER schema does not refuse this one',
    async () => {
      await apply(`
        drop schema if exists dv_other cascade;
        drop table if exists dv_docs cascade;
        create schema dv_other;
        create table dv_other.dv_docs (id int, status text);
        create view dv_other.dv_published as select id from dv_other.dv_docs where status = 'x';
        create table dv_docs (id int, status text);
      `);
      // `relname` alone matched `dv_other.dv_docs`, and the migration was refused for a view that
      // is not written against the table it retypes — the `alter` itself applies.
      await refuseDependentViews(client, RETYPE);
      await apply(RETYPE);
    },
    PGLITE_BOOT_MS,
  );

  test('a view over the table the migration DOES mean is still refused', async () => {
    await apply(`
      drop table if exists dv_docs cascade;
      create table dv_docs (id int, status text);
      create view dv_mine as select id from dv_docs where status = 'x';
    `);
    const refusal = await refuseDependentViews(client, RETYPE).then(
      () => undefined,
      (error: unknown) => error as { readonly code?: string },
    );
    expect(refusal?.code).toBe('X_MIGRATION_VIEW_DEPENDS');
  });
});
