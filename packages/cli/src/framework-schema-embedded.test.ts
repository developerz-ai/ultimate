// The list against a REAL Postgres. `framework-schema.test.ts` pins the rows against their own SQL
// text and nothing there can tell valid DDL from a statement Postgres refuses — a foreign key onto
// a table the previous statement was supposed to create is the case that proves it, because row
// order is only a correctness property against an engine that enforces it.
//
// Embedded PGlite, so this needs no external service and runs in the ordinary suite: a framework
// table that will be missing in production is exactly the defect this file exists to catch, and a
// check that skips unless someone exports a URL is a check nobody runs.

import { afterAll, describe, expect, test } from 'bun:test';
import { createPgliteClient, raw, sql } from '@ultimat3/db';
import { applyFrameworkSchema, frameworkTableNames } from './framework-schema';

describe('the framework schema, applied to the real embedded database', () => {
  // A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
  const PGLITE_BOOT_MS = 60_000;
  const client = createPgliteClient();
  const apply = (): Promise<readonly string[]> =>
    applyFrameworkSchema((statement) => client.execute(raw(statement)));

  afterAll(async () => {
    await client.close();
  });

  test(
    'every statement applies, and every table a row claims is really there afterwards',
    async () => {
      const applied = await apply();

      const rows = await client.query<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public'`,
      );
      const live = new Set(rows.map((row) => row.table_name));
      // Both directions. The claim is what an operator reads; the catalog is what is true.
      for (const table of applied) expect(live.has(table), `${table} is missing`).toBe(true);
      expect(applied).toEqual(frameworkTableNames());
    },
    PGLITE_BOOT_MS,
  );

  test(
    'applying it twice changes nothing, because every boot runs it',
    async () => {
      // `startQueue` is on every boot path there is, so the second `x dev` of the day and every
      // rolling restart re-run this. `create table if not exists` is the whole guarantee.
      await expect(apply()).resolves.toEqual(frameworkTableNames());
    },
    PGLITE_BOOT_MS,
  );

  test(
    'x_sessions really does carry the foreign key that makes row order load-bearing',
    async () => {
      const rows = await client.query<{ table_name: string }>(sql`
        select ccu.table_name
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
        where tc.table_name = 'x_sessions' and tc.constraint_type = 'FOREIGN KEY'
      `);
      expect(rows.map((row) => row.table_name)).toContain('x_users');
    },
    PGLITE_BOOT_MS,
  );
});
