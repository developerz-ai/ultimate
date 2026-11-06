// The tenant proof's write half on a real Postgres: the hash leg (`md5(t::text)` by the seed's own
// ids) catches a raw-SQL update by input id, naming table and row, and leaves the scoped read
// proven. On a throwaway database; skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName } from '@ultimat3/core';
import { type PostgresClient, postgresClient, raw } from '@ultimat3/db';
import type { ExerciseRecord } from './exercise-report';
import { urlFor } from './template-db';
import { overwrittenDocs, proveSql, releaseSql, useSql } from './tenant-proof-sql-fixture';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')('live · tenant proof, the hash leg on Postgres', () => {
  const database = probeDatabaseName('tenant_proof');
  let admin: PostgresClient | undefined;
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    admin = postgresClient({ url: adminUrl });
    await admin.execute(raw(`create database "${database}"`));
    client = postgresClient({ url: urlFor(adminUrl, database) });
    await useSql(client);
  });

  afterAll(async () => {
    releaseSql();
    await client?.close();
    await admin?.execute(raw(`drop database if exists "${database}" with (force)`));
    await admin?.close();
  });

  const crossed = (record: ExerciseRecord) => {
    expect({ name: record.name, outcome: record.outcome }).toEqual({
      name: 'tpsRawWrite',
      outcome: 'reached',
    });
    expect(record.tenant?.verdict).toBe('crossed');
    return record.tenant?.verdict === 'crossed' ? record.tenant.findings : [];
  };

  test('a raw update by input id is X_TENANT_WRITE_CROSSED, naming tps_docs and the row', async () => {
    const findings = crossed(await proveSql('tpsRawWrite', 7));
    // The scale sweep calls the primitive again in tenants of its own, overwriting their rows too:
    // A's row is the one the finding names, and it is among them.
    const overwritten = (await overwrittenDocs()).map(String);
    const write = findings.find((one) => one.code === 'X_TENANT_WRITE_CROSSED');
    expect(write).toMatchObject({ leg: 'before', table: 'tps_docs' });
    expect(overwritten).toContain(String(write?.id));
  }, 60_000);

  test('the scoped read of the same table is proven: the hash leg sees no change', async () => {
    const record = await proveSql('tpsScopedRead', 8);
    expect(record.outcome).toBe('reached');
    expect(record.tenant).toEqual({ verdict: 'proven' });
  }, 60_000);
});
