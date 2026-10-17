// `ensureSchema`, the CLI commands' boot: DDL only when this build's stamp is absent. On embedded
// PGlite, so it runs in the ordinary suite; the DML-only role this exists for is a real server's
// (`framework-schema.live.test.ts`), and this file pins what that test cannot see — that a stamped
// database receives no statement but the stamp read.

import { afterAll, describe, expect, test } from 'bun:test';
import type { DbClient } from '@ultimat3/db';
import { pgliteClient, sql } from '@ultimat3/db';
import { ensureSchema } from './framework-schema-apply';
import { STAMP_RELATION } from './framework-schema-stamp';

describe('unit · ensureSchema', () => {
  // A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
  const PGLITE_BOOT_MS = 60_000;
  const client = pgliteClient();

  afterAll(async () => {
    await client.close();
  });

  test(
    'an unstamped database is applied and stamped, so a fresh dev database needs no other step',
    async () => {
      await ensureSchema(client);
      const rows = await client.query<{ readonly stamp: string | null }>(
        sql`select obj_description(to_regclass(${STAMP_RELATION}), 'pg_class') as stamp`,
      );
      expect(rows[0]?.stamp ?? '').toStartWith('ultimate-framework-schema\n');
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a database stamped by this build receives no DDL — a role that owns nothing can boot on it',
    async () => {
      // Stamped HERE, not by the test above: run alone (`-t`) or after a reorder, this case would
      // otherwise read an unstamped database and fail on DDL it was never about. Idempotent, so on
      // the shared client it is the stamp read and nothing more.
      await ensureSchema(client);
      const stamp = await client.query<{ readonly stamp: string | null }>(
        sql`select obj_description(to_regclass(${STAMP_RELATION}), 'pg_class') as stamp`,
      );
      expect(stamp[0]?.stamp ?? '').toStartWith('ultimate-framework-schema\n');
      const written: string[] = [];
      const recording: DbClient = {
        query: (fragment) => client.query(fragment),
        one: (fragment) => client.one(fragment),
        execute: (fragment) => {
          written.push(fragment.text);
          return client.execute(fragment);
        },
      };
      await ensureSchema(recording);
      expect(written).toEqual([]);
    },
    PGLITE_BOOT_MS,
  );
});
