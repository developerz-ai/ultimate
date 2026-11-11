// The writer's read-back, proved the same way on PGlite and on a Postgres server: two tables, a
// one-column key and a composite one, digested in ONE statement; a digest moves when its row
// changes and is null once the row is gone. A fixture, so it never ships (`!src/**/*-fixture.ts`).

import { expect } from 'bun:test';
import { type DbClient, sql } from '@ultimat3/db';
import { entity, text, timestamp, uuid } from '@ultimat3/entity';
import type { SeedRow } from './seed-graph-plan';
import { entitySeedWriter } from './seed-writer';

const notes = entity('sp_notes', { columns: { id: uuid().primaryKey(), body: text() } });
const pins = entity('sp_pins', {
  columns: { noteId: uuid().primaryKey(), slot: text().primaryKey(), label: text() },
});

const ID = '00000000-0000-7000-8000-0000000000a1';

/** Keyed on an instant, as `partitionBy` requires its column to be: the key is a `Date`. */
const events = entity('sp_events', {
  columns: { id: uuid().primaryKey(), at: timestamp().primaryKey(), label: text() },
});
const AT = new Date('2026-11-10T14:05:06.789Z');
const EVENT_ROWS: readonly SeedRow[] = [
  { entity: 'sp_events', table: 'sp_events', tenant: 't', row: { id: ID, at: AT, label: 'one' } },
];

const ROWS: readonly SeedRow[] = [
  { entity: 'sp_notes', table: 'sp_notes', tenant: 't', row: { id: ID, body: 'one' } },
  {
    entity: 'sp_notes',
    table: 'sp_notes',
    tenant: 't',
    row: { id: '00000000-0000-7000-8000-0000000000a2', body: 'two' },
  },
  { entity: 'sp_pins', table: 'sp_pins', tenant: 't', row: { noteId: ID, slot: 'a', label: 'x' } },
  { entity: 'sp_pins', table: 'sp_pins', tenant: 't', row: { noteId: ID, slot: 'b', label: 'y' } },
];

export interface SnapshotProof {
  /** Statements the first snapshot sent. */
  readonly sent: number;
  readonly before: readonly (string | null)[];
  readonly again: readonly (string | null)[];
  /** After the first note changed and both pins were deleted. */
  readonly after: readonly (string | null)[];
}

/** On an empty database: creates both tables, writes the rows, snapshots around two writes. */
export async function snapshotProof(client: DbClient): Promise<SnapshotProof> {
  await client.execute(sql`create table sp_notes (id uuid primary key, body text not null)`);
  await client.execute(
    sql`create table sp_pins (note_id uuid, slot text, label text not null, primary key (note_id, slot))`,
  );
  const writer = entitySeedWriter({ entities: { notes, pins }, client });
  for (const row of ROWS) await writer.insert(row);
  let sent = 0;
  const counting = entitySeedWriter({
    entities: { notes, pins },
    client: {
      ...client,
      query: (statement) => {
        sent += 1;
        return client.query(statement);
      },
      one: (statement) => {
        sent += 1;
        return client.one(statement);
      },
    },
  });
  const before = await counting.snapshot(ROWS);
  const again = await writer.snapshot(ROWS);
  await client.execute(sql`update sp_notes set body = 'changed' where id = ${ID}`);
  await client.execute(sql`delete from sp_pins where note_id = ${ID}`);
  return { sent, before, again, after: await writer.snapshot(ROWS) };
}

export function expectSnapshotProof(proof: SnapshotProof): void {
  // One statement per snapshot, whatever the tables and key shapes: the tenant proof takes four
  // per primitive, so a statement per table was primitives × tables round trips.
  expect(proof.sent).toBe(1);
  expect(proof.before.every((digest) => typeof digest === 'string')).toBe(true);
  expect(proof.again).toEqual(proof.before);
  const { after, before } = proof;
  expect([after[0] === before[0], after[1] === before[1], after[2], after[3]]).toEqual([
    false,
    true,
    null,
    null,
  ]);
}

/**
 * A `timestamp()` key, under a session zone that is not UTC: the key crosses as its instant and is
 * matched back as one, never as `String(date)` (`… GMT-0500 …`, which no server parses) nor as the
 * session's own `at::text` spelling. `[before, after an update]`: both digests, and they differ.
 */
export async function timestampKeyProof(client: DbClient): Promise<readonly (string | null)[]> {
  await client.execute(sql`set time zone 'America/New_York'`);
  await client.execute(
    sql`create table sp_events (id uuid, at timestamptz, label text not null, primary key (id, at))`,
  );
  const writer = entitySeedWriter({ entities: { events }, client });
  for (const row of EVENT_ROWS) await writer.insert(row);
  const [before] = await writer.snapshot(EVENT_ROWS);
  await client.execute(sql`update sp_events set label = 'changed' where id = ${ID}`);
  const [after] = await writer.snapshot(EVENT_ROWS);
  return [before ?? null, after ?? null];
}

export function expectTimestampKeyProof(digests: readonly (string | null)[]): void {
  const [before, after] = digests;
  expect([typeof before, typeof after, before === after]).toEqual(['string', 'string', false]);
}
