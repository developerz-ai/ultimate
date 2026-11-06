// A row-security app's worker database on the test services: tables the migration creates belong to
// the migrator, and a suite connected with the URL it is handed is bound by the policy — the
// bootstrap `ultimate` is a superuser and would see every row. Skips unless `TEST_DATABASE_URL`.

import { describe, expect, test } from 'bun:test';
import { enableRowSecuritySql } from '@ultimat3/db';
import { acquireWorkerDatabase, dropSql } from './template-db';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';
const A = '00000000-0000-4000-8000-0000000000a1';

async function migrate(url: string): Promise<void> {
  const sql = new Bun.SQL(url);
  try {
    await sql.unsafe('create table if not exists notes (id int primary key, org_id uuid not null)');
    for (const statement of enableRowSecuritySql('notes', 'org_id', 'uuid')) {
      await sql.unsafe(statement);
    }
    await sql.unsafe(`insert into notes values (1, '${A}') on conflict do nothing`);
  } finally {
    await sql.close();
  }
}

describe.skipIf(adminUrl === '')('live · template-db · rowSecurity', () => {
  test('the worker serves as x_app, owns nothing, and an unset tenant sees no row', async () => {
    const template = `ultimate_tpl_rls_${process.pid}`;
    await using db = await acquireWorkerDatabase(
      { adminUrl, templateName: template, rowSecurity: true, migrate },
      { env: { ULTIMATE_TEST_WORKER: '1' } },
    );
    const sql = new Bun.SQL(db.url);
    try {
      const [who] = await sql.unsafe('select current_user as role');
      expect(who?.role).toBe('x_app');
      const [owner] = await sql.unsafe(
        "select pg_get_userbyid(relowner) as owner from pg_class where relname = 'notes'",
      );
      expect(owner?.owner).toBe('x_migrator');
      const [seen] = await sql.unsafe('select count(*)::int as n from notes');
      expect(seen?.n).toBe(0);
    } finally {
      await sql.close();
      const admin = new Bun.SQL(adminUrl);
      await admin.unsafe(dropSql(template));
      await admin.close();
    }
  }, 30_000);
});
