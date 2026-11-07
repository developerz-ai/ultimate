// The seed graph on PGlite — `@ultimat3/db`'s embedded Postgres, the database `x dev` boots — over
// both tracked apps: the same proof `seed-graph.live.test.ts` runs on a server, needing none, so
// it runs in the unit step. A value one engine took and the other refused fails one of the two.
// And the writer's read-back on Postgres: `md5(t::text)` per row, for both key shapes.

import { afterAll, describe, expect, test } from 'bun:test';
import { type PgliteClient, pgliteClient } from '@ultimat3/db';
import { seedAppThrough, TRACKED_APPS } from './seed-graph-apps-fixture';
import { expectSnapshotProof, snapshotProof } from './seed-writer-snapshot-fixture';
import { testName } from './test-types';

/** A cold PGlite boot plus each app's whole migration history. */
const PGLITE_SEED_MS = 120_000;

describe(testName('unit', 'seedGraph over both tracked apps, on PGlite'), () => {
  const opened: PgliteClient[] = [];
  afterAll(async () => {
    for (const client of opened) await client.close();
  });

  for (const app of TRACKED_APPS) {
    test(
      `${app.name}: every generated row inserts, with no factory`,
      async () => {
        const client = pgliteClient();
        opened.push(client);
        const counts = await seedAppThrough(client, app.root);
        expect(counts.length).toBeGreaterThan(5);
        for (const count of counts) {
          expect(count.planned).toBeGreaterThan(0);
          expect(count).toEqual({ ...count, stored: count.planned });
        }
      },
      PGLITE_SEED_MS,
    );
  }
});

describe(testName('unit', 'entitySeedWriter snapshot, on PGlite'), () => {
  const opened: PgliteClient[] = [];
  afterAll(async () => {
    for (const client of opened) await client.close();
  });
  test(
    'a row digest moves when the row changes and is null once it is gone, either key shape',
    async () => {
      const client = pgliteClient();
      opened.push(client);
      expectSnapshotProof(await snapshotProof(client));
    },
    PGLITE_SEED_MS,
  );
});
