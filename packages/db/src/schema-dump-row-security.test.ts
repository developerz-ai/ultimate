// A test database loaded from the schema dump holds the tenant policy, so a policy is tested rather
// than prod-only: `x db gen`'s statements applied, dumped, loaded into a FRESH database, and that
// database dumps back to the same bytes and refuses another tenant's row. Real embedded Postgres.

import { afterAll, describe, expect, test } from 'bun:test';
import { introspectCatalog } from './introspect-catalog';
import { pgliteClient } from './pglite';
import { rowSecureClient } from './row-secure-client';
import { enableRowSecuritySql } from './row-security';
import { APP_ROLE, assumeRole, serveAsAppRole } from './row-security-roles';
import { renderSchemaDump, SCHEMA_DUMP_HEADER } from './schema-dump';
import { loadSchemaDump } from './schema-load';
import { raw, sql } from './sql';
import { setTransactionSettings } from './transaction-settings';

const PGLITE_BOOT_MS = 60_000;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const RULE = `(org_id = (NULLIF(current_setting('x.tenant'::text, true), ''::text))::uuid) OR (current_setting('x.cross'::text, true) = 'on'::text)`;

describe('the schema dump · row security', () => {
  const replayed = pgliteClient();
  const loaded = pgliteClient();
  afterAll(async () => {
    setTransactionSettings(undefined);
    await replayed.close();
    await loaded.close();
  });

  test(
    'the policy is dumped byte for byte, loads into a fresh database, and binds there',
    async () => {
      await replayed.execute(raw('create table posts (id int primary key, org_id uuid not null)'));
      for (const statement of enableRowSecuritySql('posts', 'org_id', 'uuid')) {
        await replayed.execute(raw(statement));
      }
      const files = renderSchemaDump(await introspectCatalog({ client: replayed }));
      expect(files.find((file) => file.path === '10_policies/posts.sql')?.content).toBe(
        [
          SCHEMA_DUMP_HEADER,
          '',
          'alter table "posts" enable row level security;',
          '',
          'alter table "posts" force row level security;',
          '',
          `create policy "ultimate_tenant" on "posts" as permissive for all to public using ((${RULE})) with check ((${RULE}));`,
          '',
        ].join('\n'),
      );

      await loadSchemaDump({ files, client: loaded });
      // Load equals replay: the loaded database dumps to the bytes it was loaded from.
      expect(renderSchemaDump(await introspectCatalog({ client: loaded }))).toEqual(files);
      await loaded.execute(raw(`insert into posts values (1, '${A}'), (2, '${B}')`));
      await serveAsAppRole(loaded);
      await assumeRole(loaded, APP_ROLE);
      setTransactionSettings(() => ({ 'x.tenant': A }));
      const seen = await rowSecureClient(loaded).one<{ n: number }>(
        sql`select count(*)::int as n from posts`,
      );
      expect(seen?.n).toBe(1);
    },
    PGLITE_BOOT_MS,
  );
});
