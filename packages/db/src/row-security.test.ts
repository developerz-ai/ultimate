// The database's tenant guard, without a database: the policy text fails closed on an unset
// tenant, the provider's settings open every root transaction, and a bare statement under row
// security is exactly BEGIN, the tenant's set_config, the statement, COMMIT.

import { afterEach, describe, expect, test } from 'bun:test';
import { db, setDbClient } from './client';
import { recordingClient } from './fake';
import { reservableOver } from './fake-reservable-fixture';
import { rowSecureClient } from './row-secure-client';
import { dropRowSecuritySql, enableRowSecuritySql } from './row-security';
import { assertRowSecurityBinds } from './row-security-role';
import { sql } from './sql';
import { withTransaction } from './transaction';
import { setTransactionSettings } from './transaction-settings';

afterEach(() => {
  setTransactionSettings(undefined);
  setDbClient(undefined);
});

describe('enableRowSecuritySql', () => {
  test('enables, FORCES, and reads the tenant through nullif — unset matches nothing', () => {
    const [enable, force, policy] = enableRowSecuritySql('posts', 'org_id', 'uuid');
    expect(enable).toBe('alter table "posts" enable row level security;');
    expect(force).toBe('alter table "posts" force row level security;');
    expect(policy).toContain(`"org_id" = nullif(current_setting('x.tenant', true), '')::uuid`);
    expect(policy).toContain(`or current_setting('x.cross', true) = 'on'`);
    expect(policy).toContain(' using (');
    expect(policy).toContain(' with check (');
  });

  test('a type that is not a plain word is refused, never spliced', () => {
    expect(() => enableRowSecuritySql('posts', 'org_id', 'uuid); drop table x; --')).toThrow(
      'X_SQL_UNSAFE',
    );
  });

  test('the revert drops the policy if it exists, then unforces and disables', () => {
    expect(dropRowSecuritySql('posts')).toEqual([
      'drop policy if exists "ultimate_tenant" on "posts";',
      'alter table "posts" no force row level security;',
      'alter table "posts" disable row level security;',
    ]);
  });
});

describe('the transaction settings seam', () => {
  test('a root transaction sets the provider`s values right after BEGIN, bound', async () => {
    const pool = recordingClient();
    setTransactionSettings(() => ({ 'x.tenant': 'org_a' }));
    await withTransaction((tx) => tx.query(sql`select 1`), { client: pool });
    expect(pool.texts).toEqual(['BEGIN', 'select set_config($1, $2, true)', 'select 1', 'COMMIT']);
    expect(pool.statements[1]?.values).toEqual(['x.tenant', 'org_a']);
  });

  test('no provider: BEGIN is followed by the statement and nothing else', async () => {
    const pool = recordingClient();
    await withTransaction((tx) => tx.query(sql`select 1`), { client: pool });
    expect(pool.texts).toEqual(['BEGIN', 'select 1', 'COMMIT']);
  });
});

describe('rowSecureClient', () => {
  test('a bare statement is exactly begin, set, statement, commit', async () => {
    const pool = recordingClient();
    setDbClient(rowSecureClient(pool));
    setTransactionSettings(() => ({ 'x.tenant': 'org_a' }));
    await db().query(sql`select * from posts`);
    expect(pool.texts).toEqual([
      'BEGIN READ ONLY',
      'select set_config($1, $2, true)',
      'select * from posts',
      'COMMIT',
    ]);
  });

  test('a write is wrapped read-write; inside a transaction nothing is wrapped twice', async () => {
    const pool = recordingClient();
    // Reservable, as both real drivers are: the transaction's pin is the pool's own connection.
    setDbClient(rowSecureClient(reservableOver(pool).client));
    setTransactionSettings(() => ({ 'x.tenant': 'org_a' }));
    await withTransaction(async () => {
      await db().execute(sql`insert into posts (id) values (${'p1'})`);
      await db().query(sql`select 1`);
    });
    expect(pool.texts.filter((text) => text.startsWith('BEGIN'))).toEqual(['BEGIN']);
    expect(pool.texts.filter((text) => text.includes('set_config'))).toHaveLength(1);
  });

  test('with no tenant to set, the statement goes bare and the policy answers nothing', async () => {
    const pool = recordingClient();
    setDbClient(rowSecureClient(pool));
    await db().query(sql`select * from posts`);
    expect(pool.texts).toEqual(['select * from posts']);
  });
});

describe('assertRowSecurityBinds', () => {
  const roleIs = (row: Readonly<Record<string, unknown>>) =>
    recordingClient().on(/from pg_roles/, { rows: [row] });

  test('a superuser, a bypassrls role and an unforced owner are refused', async () => {
    for (const row of [
      { role: 'ultimate', superuser: true, bypass: false, unforced: 0 },
      { role: 'svc', superuser: false, bypass: true, unforced: 0 },
      { role: 'owner', superuser: false, bypass: false, unforced: 2 },
    ]) {
      await expect(assertRowSecurityBinds(roleIs(row))).rejects.toMatchObject({
        code: 'X_DB_ROW_SECURITY_BYPASSED',
      });
    }
  });

  test('a plain app role passes', async () => {
    const row = { role: 'x_app', superuser: false, bypass: false, unforced: 0 };
    await expect(assertRowSecurityBinds(roleIs(row))).resolves.toBeUndefined();
  });
});
