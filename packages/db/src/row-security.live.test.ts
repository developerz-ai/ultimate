// The database refuses another tenant's row, on Postgres, connected as a role row security applies
// to (`nosuperuser nobypassrls`, owning nothing): the test services' `ultimate` is a superuser and
// would see everything. `max: 1`, so "the next statement" is the same pooled backend. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db, type PostgresClient, postgresClient, setDbClient } from './client';
import { rowSecureClient } from './row-secure-client';
import { enableRowSecuritySql } from './row-security';
import { assertRowSecurityBinds } from './row-security-role';
import { raw, sql } from './sql';
import { withTransaction } from './transaction';
import { setTransactionSettings } from './transaction-settings';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const ROLE = 'x_rls_probe_app';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const asRole = (base: string): string => {
  const next = new URL(base);
  next.username = ROLE;
  next.password = ROLE;
  return next.toString();
};

let settings: Readonly<Record<string, string>> | undefined;
const count = async (): Promise<number> =>
  (await db().one<{ n: number }>(sql`select count(*)::int as n from x_rls_probe`))?.n ?? -1;

describe.skipIf(!hasPostgres)('live · postgres · row security', () => {
  let admin: PostgresClient;
  let app: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'migrate', profile: { max: 1 } });
    await admin.execute(raw('drop table if exists x_rls_probe'));
    await admin.execute(raw(`drop role if exists ${ROLE}`));
    await admin.execute(
      raw(`create role ${ROLE} login password '${ROLE}' nosuperuser nobypassrls`),
    );
    await admin.execute(raw('create table x_rls_probe (id int primary key, org_id uuid not null)'));
    for (const statement of enableRowSecuritySql('x_rls_probe', 'org_id', 'uuid')) {
      await admin.execute(raw(statement));
    }
    await admin.execute(raw(`grant select, insert, update, delete on x_rls_probe to ${ROLE}`));
    await admin.execute(raw(`insert into x_rls_probe values (1, '${A}'), (2, '${B}')`));
    app = postgresClient({ url: asRole(url ?? ''), role: 'web', profile: { max: 1 } });
    setDbClient(rowSecureClient(app));
    setTransactionSettings(() => settings);
  });

  afterAll(async () => {
    setTransactionSettings(undefined);
    setDbClient(undefined);
    await app.close();
    await admin.execute(raw('drop table if exists x_rls_probe'));
    await admin.execute(raw(`drop role if exists ${ROLE}`));
    await admin.close();
  });

  test('a raw select under tenant A sees only A', async () => {
    settings = { 'x.tenant': A };
    expect(await count()).toBe(1);
  });

  test('no tenant set sees nothing: the policy fails closed', async () => {
    settings = undefined;
    expect(await count()).toBe(0);
  });

  test('cross-tenant sees both', async () => {
    settings = { 'x.cross': 'on' };
    expect(await count()).toBe(2);
  });

  test('a write naming B under A is refused by with check', async () => {
    settings = { 'x.tenant': A };
    const error = await db()
      .execute(sql`insert into x_rls_probe values (3, ${B}::uuid)`)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeDefined();
    settings = { 'x.cross': 'on' };
    expect(await count()).toBe(2);
  });

  test('after a pooled connection returns, the next statement sees no leftover tenant', async () => {
    settings = { 'x.tenant': A };
    await withTransaction(async () => {
      expect(await count()).toBe(1);
    });
    settings = undefined;
    // The same backend (`max: 1`), bare: a session-level set_config would still say A here.
    expect(await count()).toBe(0);
  });

  test('the boot check: the superuser is refused, the app role passes', async () => {
    await expect(assertRowSecurityBinds(admin)).rejects.toMatchObject({
      code: 'X_DB_ROW_SECURITY_BYPASSED',
    });
    await expect(assertRowSecurityBinds(app)).resolves.toBeUndefined();
  });
});
