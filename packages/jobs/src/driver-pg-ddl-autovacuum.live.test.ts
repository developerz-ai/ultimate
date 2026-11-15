// The small hot tables' autovacuum triggers against a real catalog, declared once (`JOBS_STORAGE`,
// `tableStorage()`): a fresh `SQL_JOBS_TABLE` apply holds them, a hand reset is DRIFT with the
// statement that undoes it, and the next apply converges it. Postgres' defaults (50 rows + 20% of
// the table) wait out more dead rows than a 43-row `x_scheduler_state` holds live ones (25% dead,
// production 2026-11-14). Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw, readTableStorageDrift } from '@ultimat3/db';
import { JOBS_STORAGE, SQL_JOBS_TABLE } from './driver-pg-ddl';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_ddl_autovacuum_live');
const HOT = ['x_job_workers', 'x_outbox', 'x_scheduler_state'];

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

  test('each hot table declares a vacuum and an analyze trigger', () => {
    const declared = JOBS_STORAGE.filter((storage) => storage.autovacuum !== undefined);
    expect(declared.map((storage) => storage.table).sort()).toEqual(HOT);
    for (const { autovacuum } of declared) {
      expect(Object.keys(autovacuum ?? {}).sort()).toEqual([
        'analyzeScaleFactor',
        'analyzeThreshold',
        'vacuumScaleFactor',
        'vacuumThreshold',
      ]);
    }
  });

  test('a fresh install holds every declaration', async () => {
    await apply();
    expect(await readTableStorageDrift(client, JOBS_STORAGE)).toEqual([]);
  });

  test('a hand reset is drift, and the next apply undoes it', async () => {
    await client.execute(
      raw(
        'alter table x_scheduler_state reset (autovacuum_vacuum_threshold, autovacuum_vacuum_scale_factor)',
      ),
    );
    const drift = await readTableStorageDrift(client, JOBS_STORAGE);
    expect(drift.map(({ table, parameter }) => `${table}.${parameter}`)).toEqual([
      'x_scheduler_state.autovacuum_vacuum_threshold',
      'x_scheduler_state.autovacuum_vacuum_scale_factor',
    ]);
    await apply();
    expect(await readTableStorageDrift(client, JOBS_STORAGE)).toEqual([]);
  });
});
