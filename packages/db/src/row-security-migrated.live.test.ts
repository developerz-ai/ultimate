// End to end on Postgres: an app with `database.rowSecurity` on, its schema written by `x db gen`'s
// generator and applied as the migrator, refuses a raw `sql` read of another tenant's row when it
// serves as the app role. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db, type PostgresClient, postgresClient, setDbClient } from './client';
import type { EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { introspectSchema } from './introspect';
import { rowSecureClient } from './row-secure-client';
import { assertRowSecurityBinds } from './row-security-role';
import { APP_ROLE, assumeRole, ensureRowSecurityRoles, MIGRATOR_ROLE } from './row-security-roles';
import { raw, sql } from './sql';
import { statementsOf } from './statement-split';
import { setTransactionSettings } from './transaction-settings';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const TABLE = 'rls_gen_posts';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

const col = (column: string, primaryKey = false) => ({
  property: column,
  column,
  kind: 'uuid',
  notNull: true,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});
const posts: EntityDescriptionLike = {
  name: TABLE,
  table: TABLE,
  primaryKey: ['id'],
  columns: [col('id', true), col('org_id')],
  indexes: [],
};

let settings: Readonly<Record<string, string>> | undefined;
const visible = async (): Promise<number> =>
  (await db().one<{ n: number }>(sql`select count(*)::int as n from ${raw(TABLE)}`))?.n ?? -1;

describe.skipIf(!hasPostgres)('live · postgres · row security, migrated by x db gen', () => {
  let admin: PostgresClient;
  let migrator: PostgresClient;
  let app: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'migrate', profile: { max: 1 } });
    await admin.execute(raw(`drop table if exists ${TABLE}`));
    await ensureRowSecurityRoles(admin);
    const migration = generateMigration({
      entities: [posts],
      current: { tables: [] },
      name: 'initial',
      rowSecurity: { enabled: true, tenants: [{ table: TABLE, column: 'org_id' }] },
    });
    // The migrator owns what it creates, so the forced policy is what binds the app role.
    migrator = postgresClient({ url: url ?? '', role: 'migrate', profile: { max: 1 } });
    await assumeRole(migrator, MIGRATOR_ROLE);
    for (const statement of statementsOf(migration.up)) await migrator.execute(raw(statement));
    await migrator.execute(raw(`insert into ${TABLE} values ('${A}', '${A}'), ('${B}', '${B}')`));
    app = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await assumeRole(app, APP_ROLE);
    setDbClient(rowSecureClient(app));
    setTransactionSettings(() => settings);
  });

  afterAll(async () => {
    setTransactionSettings(undefined);
    setDbClient(undefined);
    await app?.close();
    await migrator?.close();
    await admin?.execute(raw(`drop table if exists ${TABLE}`));
    await admin?.close();
  });

  test('the app role is bound; the migrator is not, and still sees every row', async () => {
    await expect(assertRowSecurityBinds(app)).resolves.toBeUndefined();
    await expect(assertRowSecurityBinds(migrator)).rejects.toMatchObject({
      code: 'X_DB_ROW_SECURITY_BYPASSED',
    });
    const all = await migrator.one<{ n: number }>(
      sql`select count(*)::int as n from ${raw(TABLE)}`,
    );
    expect(all?.n).toBe(2);
  });

  test("a raw read under tenant A sees A's row and never B's", async () => {
    settings = { 'x.tenant': A };
    expect(await visible()).toBe(1);
    const other = await db().query(sql`select id from ${raw(TABLE)} where org_id = ${B}::uuid`);
    expect(other).toEqual([]);
  });

  test('no tenant set sees nothing', async () => {
    settings = undefined;
    expect(await visible()).toBe(0);
  });

  test('the live catalog agrees with the migration: the policy is there, forced', async () => {
    const live = await introspectSchema({ client: admin });
    const table = live.tables.find((candidate) => candidate.name === TABLE);
    expect(table?.policyNames).toEqual(['ultimate_tenant']);
  });
});
