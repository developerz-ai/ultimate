// Single responsibility: `AUTH_TABLES` is the WHOLE auth schema a boot applies, upgrades included.
// `X_USERS_MIGRATION_1_3` was exported for an app to run by hand and applied by nothing, so a
// database created before 1.3 kept an `x_users` with no `scopes` and no `external_id` forever.

import { afterAll, describe, expect, test } from 'bun:test';
import { createPgliteClient, raw } from '@ultimat3/db';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const client = createPgliteClient();

afterAll(async () => {
  await client.close();
});

const apply = async (ddl: readonly string[]): Promise<void> => {
  for (const entry of ddl) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
};

const columnsOf = async (table: string): Promise<readonly string[]> =>
  (
    await client.query<{ column_name: string }>(
      raw(`select column_name from information_schema.columns where table_name = '${table}'`),
    )
  ).map((row) => row.column_name);

describe('AUTH_TABLES upgrades an older x_users in place', () => {
  test(
    'a 1.2 users table gains scopes and external_id, and a second boot changes nothing',
    async () => {
      // The table as 1.2 created it: no `scopes`, no `external_id`.
      await client.execute(
        raw(`create table x_users (
          id uuid primary key, email text not null unique, email_verified_at timestamptz,
          password_hash text, org_id uuid, roles text[] not null default '{}',
          permissions text[] not null default '{}', mfa_secret text,
          recovery_code_hashes text[] not null default '{}', disabled_at timestamptz,
          created_at timestamptz not null default now())`),
      );
      await apply(AUTH_TABLES);
      expect(await columnsOf('x_users')).toEqual(expect.arrayContaining(['scopes', 'external_id']));
      await apply(AUTH_TABLES);
      expect(await columnsOf('x_sessions')).toContain('mfa_satisfied');
    },
    PGLITE_BOOT_MS,
  );
});
