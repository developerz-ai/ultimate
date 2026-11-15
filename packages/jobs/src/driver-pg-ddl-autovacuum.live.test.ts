// The small hot tables' autovacuum parameters, as the catalog holds them after `SQL_JOBS_TABLE` is
// applied — to a fresh database, and again to one an operator reset by hand: the install point
// re-converges every boot. Postgres' defaults (50 rows + 20% of the table) wait out more dead rows
// than a 43-row `x_scheduler_state` holds live ones (25% dead, production 2026-11-14).
// Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { HOT_TABLE_AUTOVACUUM, SQL_JOBS_TABLE } from './driver-pg-ddl';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_ddl_autovacuum_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · the small hot tables vacuum early', () => {
  let admin: PostgresClient;
  let client: PostgresClient;

  const apply = async (): Promise<void> => {
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
  };

  /** Each table's `reloptions`, as `name=value` strings sorted. */
  const options = async (): Promise<Record<string, readonly string[]>> => {
    const rows = await client.query<{ relname: string; reloptions: readonly string[] | null }>({
      text: `select relname, reloptions from pg_class
              where relkind = 'r' and relname = any($1::text[])`,
      values: [Object.keys(HOT_TABLE_AUTOVACUUM)],
    });
    return Object.fromEntries(rows.map((row) => [row.relname, [...(row.reloptions ?? [])].sort()]));
  };

  const declared = (): Record<string, readonly string[]> =>
    Object.fromEntries(
      Object.entries(HOT_TABLE_AUTOVACUUM).map(([table, parameters]) => [
        table,
        Object.entries(parameters)
          .map(([name, value]) => `${name}=${String(value)}`)
          .sort(),
      ]),
    );

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 1 } });
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('the three tables are declared, each with a vacuum and an analyze trigger', () => {
    expect(Object.keys(HOT_TABLE_AUTOVACUUM).sort()).toEqual([
      'x_job_workers',
      'x_outbox',
      'x_scheduler_state',
    ]);
    for (const parameters of Object.values(HOT_TABLE_AUTOVACUUM)) {
      expect(Object.keys(parameters).sort()).toEqual([
        'autovacuum_analyze_scale_factor',
        'autovacuum_analyze_threshold',
        'autovacuum_vacuum_scale_factor',
        'autovacuum_vacuum_threshold',
      ]);
    }
  });

  test('a fresh install holds the declaration', async () => {
    await apply();
    expect(await options()).toEqual(declared());
  });

  test('a hand reset is undone by the next apply', async () => {
    await client.execute(
      raw(
        'alter table x_scheduler_state reset (autovacuum_vacuum_threshold, autovacuum_vacuum_scale_factor)',
      ),
    );
    expect((await options())['x_scheduler_state']).not.toEqual(declared()['x_scheduler_state']);
    await apply();
    expect(await options()).toEqual(declared());
  });
});
