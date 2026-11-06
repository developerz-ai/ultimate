// Row security on PGlite. Its default role is a superuser, and forced row security answered 2 of 2
// rows to it — so the session must serve as `x_app`, under which a raw select under tenant A sees
// 1 of 2. Fails if the session stays superuser: that is the probe's 2 of 2.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { pgliteClient } from './pglite';
import { rowSecureClient } from './row-secure-client';
import { enableRowSecuritySql } from './row-security';
import { assertRowSecurityBinds } from './row-security-role';
import { APP_ROLE, assumeRole, ensureRowSecurityRoles, MIGRATOR_ROLE } from './row-security-roles';
import { raw, sql } from './sql';
import { setTransactionSettings } from './transaction-settings';

const PGLITE_BOOT_MS = 30_000;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('row security on PGlite', () => {
  const client = pgliteClient();
  afterEach(() => setTransactionSettings(undefined));
  afterAll(async () => {
    await client.close();
  });

  test(
    'the migrator owns the table, x_app serves, and tenant A sees 1 of 2',
    async () => {
      await ensureRowSecurityRoles(client);
      await assumeRole(client, MIGRATOR_ROLE);
      await client.execute(raw('create table posts (id int primary key, org_id uuid not null)'));
      for (const statement of enableRowSecuritySql('posts', 'org_id', 'uuid')) {
        await client.execute(raw(statement));
      }
      await client.execute(raw(`insert into posts values (1, '${A}'), (2, '${B}')`));
      await assumeRole(client, APP_ROLE);
      await assertRowSecurityBinds(client);

      const app = rowSecureClient(client);
      const count = async (): Promise<number> =>
        (await app.one<{ n: number }>(sql`select count(*)::int as n from posts`))?.n ?? -1;
      setTransactionSettings(() => ({ 'x.tenant': A }));
      expect(await count()).toBe(1);
      setTransactionSettings(undefined);
      expect(await count()).toBe(0);
    },
    PGLITE_BOOT_MS,
  );
});
