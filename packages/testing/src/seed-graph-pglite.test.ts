// The seed graph on PGlite — `@ultimat3/db`'s embedded Postgres, the database `x dev` boots — over
// both tracked apps: the same proof `seed-graph.live.test.ts` runs on a server, needing none, so
// it runs in the unit step. A value one engine took and the other refused fails one of the two.
// And the writer's read-back on Postgres: `md5(t::text)` per row, for both key shapes.

import { afterAll, describe, expect, test } from 'bun:test';
import { type PgliteClient, pgliteClient, sql } from '@ultimat3/db';
import { entity, text, uuid } from '@ultimat3/entity';
import { seedAppThrough, TRACKED_APPS } from './seed-graph-apps-fixture';
import type { SeedRow } from './seed-graph-plan';
import { entitySeedWriter } from './seed-writer';
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

const notes = entity('sp_notes', { columns: { id: uuid().primaryKey(), body: text() } });
const pins = entity('sp_pins', {
  columns: { noteId: uuid().primaryKey(), slot: text().primaryKey(), label: text() },
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
      await client.execute(sql`create table sp_notes (id uuid primary key, body text not null)`);
      await client.execute(
        sql`create table sp_pins (note_id uuid, slot text, label text not null, primary key (note_id, slot))`,
      );
      const writer = entitySeedWriter({ entities: { notes, pins }, client });
      const id = '00000000-0000-7000-8000-0000000000a1';
      const rows: SeedRow[] = [
        { entity: 'sp_notes', table: 'sp_notes', tenant: 't', row: { id, body: 'one' } },
        {
          entity: 'sp_notes',
          table: 'sp_notes',
          tenant: 't',
          row: { id: '00000000-0000-7000-8000-0000000000a2', body: 'two' },
        },
        {
          entity: 'sp_pins',
          table: 'sp_pins',
          tenant: 't',
          row: { noteId: id, slot: 'a', label: 'x' },
        },
      ];
      for (const row of rows) await writer.insert(row);
      const before = await writer.snapshot(rows);
      expect(before.every((digest) => typeof digest === 'string')).toBe(true);
      expect(await writer.snapshot(rows)).toEqual(before);
      await client.execute(sql`update sp_notes set body = 'changed' where id = ${id}`);
      await client.execute(sql`delete from sp_pins where note_id = ${id}`);
      const after = await writer.snapshot(rows);
      expect([after[0] === before[0], after[1] === before[1], after[2]]).toEqual([
        false,
        true,
        null,
      ]);
    },
    PGLITE_SEED_MS,
  );
});
