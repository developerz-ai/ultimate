// The seed graph against Postgres, over both tracked apps' own entities and their own migrations:
// with no factory written, every generated row inserts through `entitySeedWriter({ client })` —
// every foreign key, CHECK, unique key and same-tenant composite key the real schema declares
// accepts it. Skips unless `TEST_DATABASE_URL`. `seed-graph-pglite.test.ts` is the same on PGlite.

import { afterAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName } from '@ultimat3/core';
import { type PostgresClient, postgresClient, raw } from '@ultimat3/db';
import { seedAppThrough, TRACKED_APPS } from './seed-graph-apps-fixture';
import { expectSnapshotProof, snapshotProof } from './seed-writer-snapshot-fixture';
import { urlFor } from './template-db';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')('live · seedGraph over both tracked apps', () => {
  const admin = adminUrl === '' ? undefined : postgresClient({ url: adminUrl });
  const opened: PostgresClient[] = [];
  const created: string[] = [];

  afterAll(async () => {
    for (const client of opened) await client.close();
    for (const name of created) {
      await admin?.execute(raw(`drop database if exists "${name}" with (force)`));
    }
    await admin?.close();
  });

  for (const app of TRACKED_APPS) {
    test(`${app.name}: every generated row inserts, with no factory`, async () => {
      const database = probeDatabaseName(`seed_graph_${app.name}`);
      created.push(database);
      await admin?.execute(raw(`create database "${database}"`));
      const client = postgresClient({ url: urlFor(adminUrl, database) });
      opened.push(client);

      const counts = await seedAppThrough(client, app.root);
      expect(counts.length).toBeGreaterThan(5);
      for (const count of counts) {
        expect(count.planned).toBeGreaterThan(0);
        expect(count.stored).toBe(count.planned);
      }
    }, 60_000);
  }

  // An untyped key parameter, typed by the server as the column: the same proof PGlite passes.
  test('the writer snapshot digests both key shapes in one statement', async () => {
    const database = probeDatabaseName('seed_snapshot');
    created.push(database);
    await admin?.execute(raw(`create database "${database}"`));
    const client = postgresClient({ url: urlFor(adminUrl, database) });
    opened.push(client);
    expectSnapshotProof(await snapshotProof(client));
  }, 60_000);
});
