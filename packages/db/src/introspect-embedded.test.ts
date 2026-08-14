// Single responsibility: `introspect()`'s three catalog queries against the real embedded
// database. `introspect.test.ts` pins the row -> description fold with a recording client, and
// nothing there can tell a correct catalog query from one Postgres answers differently — a
// composite foreign key is the case that proves it, because the wrong join returns a cross
// product of source and target columns that a stubbed row set would never produce.

import { afterAll, describe, expect, test } from 'bun:test';
import { findTable, introspect } from './introspect';
import { createPgliteClient } from './pglite';
import { sql } from './sql';

describe('introspect · the real embedded database', () => {
  // A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
  const PGLITE_BOOT_MS = 30_000;
  const client = createPgliteClient();

  afterAll(async () => {
    await client.close();
  });

  test(
    'a composite foreign key comes back as one ordered pair of column lists, not a cross product',
    async () => {
      await client.execute(sql`drop table if exists introspect_memberships`);
      await client.execute(sql`drop table if exists introspect_users`);
      await client.execute(sql`
        create table introspect_users (
          tenant_id uuid not null,
          id uuid not null,
          primary key (tenant_id, id)
        )
      `);
      // Source order (org_id, user_id) deliberately does NOT match target order, and neither list
      // is alphabetical: a query that sorts by attnum instead of key position swaps the pairing.
      await client.execute(sql`
        create table introspect_memberships (
          id uuid primary key,
          user_id uuid not null,
          org_id uuid not null,
          constraint introspect_memberships_org_user_fkey
            foreign key (org_id, user_id) references introspect_users (tenant_id, id) on delete cascade
        )
      `);

      const schema = await introspect({ client });
      const memberships = findTable(schema, 'introspect_memberships');

      expect(memberships?.foreignKeys).toEqual([
        {
          name: 'introspect_memberships_org_user_fkey',
          columns: ['org_id', 'user_id'],
          referencedTable: 'introspect_users',
          referencedColumns: ['tenant_id', 'id'],
          onDelete: 'c',
        },
      ]);

      await client.execute(sql`drop table introspect_memberships`);
      await client.execute(sql`drop table introspect_users`);
    },
    PGLITE_BOOT_MS,
  );
});
