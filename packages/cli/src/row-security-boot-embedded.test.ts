// The boot on PGlite, whose one session is a superuser: armed as `embedded`, it serves as `x_app`
// and a raw read under tenant A sees A's row alone; armed as an external database would be, the
// same session is refused. A table a superuser created before the flag is reachable all the same.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  db,
  enableRowSecuritySql,
  pgliteClient,
  raw,
  setDbClient,
  setTransactionSettings,
  sql,
} from '@ultimat3/db';
import { armRowSecurity } from './row-security-boot';

const PGLITE_BOOT_MS = 30_000;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('armRowSecurity · embedded', () => {
  const client = pgliteClient();
  afterEach(() => setDbClient(undefined));
  afterAll(async () => {
    await client.close();
  });

  test(
    'as external the superuser is refused; as embedded it serves as x_app and A sees 1 of 2',
    async () => {
      await client.execute(raw('create table posts (id int primary key, org_id uuid not null)'));
      for (const statement of enableRowSecuritySql('posts', 'org_id', 'uuid')) {
        await client.execute(raw(statement));
      }
      await client.execute(raw(`insert into posts values (1, '${A}'), (2, '${B}')`));
      setDbClient(client);
      await expect(armRowSecurity(true)).rejects.toMatchObject({
        code: 'X_DB_ROW_SECURITY_BYPASSED',
      });

      const undo = await armRowSecurity(true, { embedded: true });
      setTransactionSettings(() => ({ 'x.tenant': A }));
      const count = async (): Promise<number> =>
        (await db().one<{ n: number }>(sql`select count(*)::int as n from posts`))?.n ?? -1;
      expect(await count()).toBe(1);
      await undo();
      const role = await client.one<{ role: string }>(sql`select current_user as role`);
      expect(role?.role).not.toBe('x_app');
    },
    PGLITE_BOOT_MS,
  );
});
