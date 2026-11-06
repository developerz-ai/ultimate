// Single responsibility: the partitioned-table probe on a real Postgres — the server
// `ROLE=migrate` talks to, where the embedded suites cannot reach. `checkDrift` answers `ok: true`
// with a partition attached, the schema dump loads back to the same bytes, and a concurrent build
// on the parent is `X_MIGRATION_CONCURRENT_PARTITIONED`. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { NO_TRANSACTION_MARKER } from './concurrent-index';
import { dbExecutor } from './db-executor';
import { checkDrift } from './drift';
import { DbError } from './errors';
import { introspectCatalog } from './introspect-catalog';
import { migrate } from './migrate';
import { CREATE_EVENTS, partitionFor } from './partitioned-fixture';
import { renderSchemaDump } from './schema-dump';
import { loadSchemaDump } from './schema-load';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const LIVE_MS = 30_000;

describe.skipIf(!hasPostgres)('a partitioned table · on Postgres', () => {
  const database = probeDatabaseName('x_partitioned');
  const admin = postgresClient({ url: url ?? '' });
  let client: PostgresClient;
  const migrations = [CREATE_EVENTS];

  beforeAll(async () => {
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      database,
    );
    await admin.execute(raw(`create database ${database} template template0`));
    const target = new URL(url ?? '');
    target.pathname = `/${database}`;
    client = postgresClient({ url: target.toString() });
    await migrate({ migrations, appVersion: 'test', client });
    await client.execute(raw(partitionFor('2026_12', '2026-12-01', '2027-01-01')));
  }, LIVE_MS);

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  });

  test('the probe answers `{"ok":true,"differences":[]}`', async () => {
    expect(await checkDrift({ migrations, client })).toEqual({ ok: true, differences: [] });
  });

  test(
    'the schema dump loads back to the same bytes',
    async () => {
      const before = renderSchemaDump(await introspectCatalog({ client }));
      expect(before.map((file) => file.path)).toContain('04_tables/events.sql');
      await client.execute(raw('drop schema public cascade'));
      await client.execute(raw('create schema public'));
      await loadSchemaDump({ client, files: before });
      expect(renderSchemaDump(await introspectCatalog({ client }))).toEqual(before);
    },
    LIVE_MS,
  );

  test(
    'a concurrent build on the parent is X_MIGRATION_CONCURRENT_PARTITIONED',
    async () => {
      await client.execute(raw('drop schema public cascade'));
      await client.execute(raw('create schema public'));
      const build = {
        id: '20261102000000_index_at',
        name: 'index at',
        up: `${NO_TRANSACTION_MARKER}\ncreate index concurrently "events_at_idx" on "events" ("at");`,
        down: '',
      };
      const refusal = await migrate({
        migrations: [...migrations, build],
        appVersion: 'test',
        client,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (!(refusal instanceof DbError)) expect.unreachable('the build must be refused');
      expect(refusal.code).toBe('X_MIGRATION_CONCURRENT_PARTITIONED');
    },
    LIVE_MS,
  );
});
