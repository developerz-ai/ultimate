// Single responsibility: `introspectSchema()` on a PARTITIONED table, against the real embedded
// catalog. The parent is what migrations declare, so it carries its keys, indexes, checks and
// triggers; every partition, a sub-partition included, is Postgres' and appears nowhere — not as a
// table, not as a foreign key cloned onto it, not as a second key pointing into one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findTable, introspectSchema, type SchemaDescription } from './introspect';
import { pgliteClient } from './pglite';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const PGLITE_BOOT_MS = 60_000;

const SCHEMA = `
  create table orgs (id uuid primary key);
  create table events (
    id uuid not null,
    org_id uuid not null references orgs (id),
    at timestamptz not null,
    kind text not null,
    constraint events_kind_present check (kind <> ''),
    primary key (id, at)
  ) partition by range (at);
  create index events_kind_idx on events (kind);
  create table events_2026_11 partition of events
    for values from ('2026-11-01') to ('2026-12-01');
  create table events_2026_12 partition of events
    for values from ('2026-12-01') to ('2027-01-01') partition by range (at);
  create table events_2026_12_early partition of events_2026_12
    for values from ('2026-12-01') to ('2026-12-16');
  create function refuse() returns trigger language plpgsql as $$ begin return null; end $$;
  create trigger events_refuse before update on events for each row execute function refuse();
  create table notes (
    id uuid primary key,
    event_id uuid not null,
    event_at timestamptz not null,
    constraint notes_event_fkey foreign key (event_id, event_at) references events (id, at)
  );
`;

describe('introspectSchema · a partitioned table', () => {
  const client = pgliteClient();
  let schema: SchemaDescription;

  beforeAll(async () => {
    for (const statement of statementsOf(SCHEMA)) await client.execute(raw(statement));
    schema = await introspectSchema({ client });
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('a partition, and a partition of a partition, is not a table of the app', () => {
    expect(schema.tables.map((table) => table.name)).toEqual(['events', 'notes', 'orgs']);
  });

  test('the parent answers its own key, indexes, checks and triggers, and says it is partitioned', () => {
    const events = findTable(schema, 'events');
    expect(events?.partitioned).toBe(true);
    expect(events?.primaryKey).toEqual(['id', 'at']);
    expect(events?.indexes.map((index) => index.name)).toEqual(['events_kind_idx', 'events_pkey']);
    expect(events?.checkNames).toEqual(['events_kind_present']);
    expect(events?.triggerNames).toEqual(['events_refuse']);
    expect(events?.foreignKeys.map((key) => key.name)).toEqual(['events_org_id_fkey']);
  });

  test('a key into a partitioned table is ONE key, not one more per partition', () => {
    // Postgres adds `notes_event_fkey_1`, `_2`, … pointing at each partition (`conparentid <> 0`).
    expect(findTable(schema, 'notes')?.foreignKeys).toEqual([
      {
        name: 'notes_event_fkey',
        columns: ['event_id', 'event_at'],
        referencedTable: 'events',
        referencedColumns: ['id', 'at'],
        onDelete: 'a',
      },
    ]);
  });

  test('an unpartitioned table carries no `partitioned` field at all', () => {
    expect(findTable(schema, 'notes')).not.toHaveProperty('partitioned');
    expect(findTable(schema, 'orgs')).not.toHaveProperty('partitioned');
  });
});
