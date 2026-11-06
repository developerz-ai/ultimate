// A rollback over a DESTRUCTIVE migration against a real Postgres: the newer build's migrate role
// records the bit at apply, and the older build's refuses before anything serves. Split from
// `migrate.live.test.ts` at its size ceiling. Skips unless `TEST_DATABASE_URL` is set.

import { describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { LEDGER_TABLE, type Migration, migrate, migrationChecksum, readLedger } from './migrate';
import { raw, sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

// The operator can name the row the older build may serve over.
describe.skipIf(!hasPostgres)('live · postgres · a rollback across a dropped column', () => {
  const ALLOW = 'ROLLBACK_ALLOW_DESTRUCTIVE';
  const base: Migration = {
    id: '20260101000400_live_destructive_base',
    name: 'live destructive base',
    up: 'create table "live_destructive_base" ("id" uuid primary key, "legacy" text)',
    down: 'drop table "live_destructive_base"',
  };
  const dropped: Migration = {
    id: '20260101000500_live_destructive_drop',
    name: 'live destructive drop',
    up: 'alter table "live_destructive_base" drop column "legacy"',
    down: 'alter table "live_destructive_base" add column "legacy" text',
  };

  const reset = async (client: PostgresClient): Promise<void> => {
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
    await client.execute(raw('drop table if exists "live_destructive_base"'));
  };

  test('the ledger records the bit at apply, and the older build refuses to serve over it', async () => {
    const client = postgresClient({ url: url ?? '' });
    delete Bun.env[ALLOW];
    try {
      await reset(client);
      await migrate({ migrations: [base, dropped], appVersion: '1.6.0', client });
      const ledger = await readLedger(client);
      expect(ledger.map((row) => [row.id, row.destructive])).toEqual([
        [base.id, false],
        [dropped.id, true],
      ]);

      let code = '';
      try {
        await migrate({ migrations: [base], appVersion: '1.5.0', client });
      } catch (error) {
        code = (error as { code: string }).code;
      }
      expect(code).toBe('X_MIGRATION_ROLLBACK_DESTRUCTIVE');

      Bun.env[ALLOW] = dropped.id;
      const allowed = await migrate({ migrations: [base], appVersion: '1.5.0', client });
      expect(allowed.applied).toEqual([]);
      expect(allowed.ahead).toEqual([dropped.id]);
    } finally {
      delete Bun.env[ALLOW];
      await reset(client);
      await client.close();
    }
  }, 15_000);

  test('a ledger from before the bit gains the column, and its rows read null: a warning', async () => {
    const client = postgresClient({ url: url ?? '' });
    try {
      await reset(client);
      // The ledger exactly as every earlier release created it: no `destructive` column.
      await client.execute(
        raw(`create table ${LEDGER_TABLE} (
          id text primary key, name text not null, checksum text not null,
          applied_at timestamptz not null default now(), app_version text not null,
          duration_ms integer not null)`),
      );
      expect((await readLedger(client)).map((row) => row.destructive)).toEqual([]);
      await client.execute(
        sql`insert into ${raw(LEDGER_TABLE)} (id, name, checksum, app_version, duration_ms)
            values (${dropped.id}, ${dropped.name}, 'from-an-older-ledger', '1.6.0', 1)`,
      );
      await client.execute(raw('create table "live_destructive_base" ("id" uuid primary key)'));
      await client.execute(
        sql`insert into ${raw(LEDGER_TABLE)} (id, name, checksum, app_version, duration_ms)
            values (${base.id}, ${base.name}, ${migrationChecksum(base)}, '1.5.0', 1)`,
      );
      const report = await migrate({ migrations: [base], appVersion: '1.5.0', client });
      expect(report.ahead).toEqual([dropped.id]);
      expect((await readLedger(client)).map((row) => row.destructive)).toEqual([null, null]);
    } finally {
      await reset(client);
      await client.close();
    }
  }, 15_000);
});
