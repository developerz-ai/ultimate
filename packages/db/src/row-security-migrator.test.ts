// The migrate step held as `x_migrator` on PGlite: what the superuser created before the flag —
// a table with a serial, a view, an enum, a function — is handed over, so the next migration may
// alter it; the undo gives the session back to the bootstrap user.

import { afterAll, describe, expect, test } from 'bun:test';
import { pgliteClient } from './pglite';
import { holdMigratorRole } from './row-security-migrator';
import { raw, sql } from './sql';

const PGLITE_BOOT_MS = 30_000;

describe('holdMigratorRole', () => {
  const client = pgliteClient();
  afterAll(async () => {
    await client.close();
  });

  test(
    'a superuser-owned table, view, enum and function become x_migrator`s, and alterable by it',
    async () => {
      for (const statement of [
        "create type mood as enum ('ok')",
        'create table legacy (id serial primary key, m mood)',
        'create view legacy_ids as select id from legacy',
        'create function legacy_count() returns bigint language sql as $$ select count(*) from legacy $$',
      ]) {
        await client.execute(raw(statement));
      }
      const undo = await holdMigratorRole(client);
      const me = await client.one<{ role: string }>(sql`select current_user as role`);
      expect(me?.role).toBe('x_migrator');
      await client.execute(raw('alter table legacy add column title text'));
      await client.execute(raw("alter type mood add value 'sad'"));
      await client.execute(raw('create or replace view legacy_ids as select id from legacy'));
      await client.execute(
        raw(
          'create or replace function legacy_count() returns bigint language sql as $$ select 0::bigint $$',
        ),
      );
      await undo();
      const owners = await client.query<{ owner: string }>(
        sql`select distinct pg_get_userbyid(relowner) as owner from pg_class where relname in ('legacy', 'legacy_ids', 'legacy_id_seq')`,
      );
      expect(owners.map((row) => row.owner)).toEqual(['x_migrator']);
      const back = await client.one<{ role: string }>(sql`select current_user as role`);
      expect(back?.role).not.toBe('x_migrator');
    },
    PGLITE_BOOT_MS,
  );
});
