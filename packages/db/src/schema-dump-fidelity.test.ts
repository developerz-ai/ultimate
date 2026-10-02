// Single responsibility: the schema dump's FIDELITY for what it used to get wrong in silence — a
// virtual generated column dumped `stored`, a trigger filed for a table the dump does not create,
// four catalog facts absent from both the dump and `unrendered.sql`. Asked of the real embedded
// database; its own boot, because `schema-dump.test.ts` is at the file-size ceiling.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { introspectCatalog } from './introspect-catalog';
import { createPgliteClient } from './pglite';
import { renderSchemaDump, type SchemaDumpFile } from './schema-dump';
import { loadSchemaDump } from './schema-load';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const PGLITE_BOOT_MS = 60_000;

describe('the schema dump · fidelity', () => {
  const client = createPgliteClient();
  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const reset = (): Promise<void> => apply('drop schema public cascade; create schema public;');
  const dump = async (): Promise<readonly SchemaDumpFile[]> =>
    renderSchemaDump(await introspectCatalog({ client }));
  const file = (files: readonly SchemaDumpFile[], path: string): string =>
    files.find((entry) => entry.path === path)?.content ?? '';
  const unrendered = async (): Promise<readonly string[]> =>
    (await introspectCatalog({ client })).unrendered.map(
      (object) =>
        `${object.kind} ${object.name}${object.table === null ? '' : ` on ${object.table}`}`,
    );

  beforeEach(reset, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('a VIRTUAL generated column is dumped virtual, and loads back as one', async () => {
    await apply(`
      create table sums (
        a int not null,
        doubled int generated always as (a * 2) virtual,
        tripled int generated always as (a * 3) stored
      );
    `);
    const before = await dump();
    const table = file(before, '04_tables/sums.sql');
    expect(table).toContain('"doubled" integer generated always as ((a * 2)) virtual');
    expect(table).toContain('"tripled" integer generated always as ((a * 3)) stored');

    await reset();
    await loadSchemaDump({ client, files: before });
    expect(await dump()).toEqual(before);
    const kinds = await client.query<{ name: string; kind: string }>(
      raw(
        `select attname as name, attgenerated as kind from pg_attribute ` +
          `where attrelid = 'sums'::regclass and attnum > 0 order by attnum`,
      ),
    );
    expect(kinds.map((row) => row.kind)).toEqual(['', 'v', 's']);
  });

  test('a trigger on a relation the dump does not create is named, never filed', async () => {
    await apply(`
      create table events (id int, k int) partition by range (k);
      create table plain (id int primary key);
      create function noop() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger events_touch before insert on events for each row execute function noop();
      create trigger plain_touch before insert on plain for each row execute function noop();
    `);
    const before = await dump();
    // The plain table's trigger is still rendered; the partitioned one's has no table to load on.
    expect(before.map((entry) => entry.path).filter((path) => path.startsWith('09_'))).toEqual([
      '09_triggers/plain.sql',
    ]);
    expect(await unrendered()).toContain('trigger events_touch on events');

    await reset();
    // It threw `X_SCHEMA_DUMP_DRIFT`: `09_triggers/events.sql` named a table no file creates.
    await loadSchemaDump({ client, files: before });
  });

  test('a trigger on a VIEW is still rendered: the view is a relation the dump creates', async () => {
    await apply(`
      create table base (id int primary key);
      create view base_ids as select id from base;
      create function redirect() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger base_ids_insert instead of insert on base_ids
        for each row execute function redirect();
    `);
    const before = await dump();
    expect(before.map((entry) => entry.path)).toContain('09_triggers/base_ids.sql');
    await reset();
    await loadSchemaDump({ client, files: before });
    expect(await dump()).toEqual(before);
  });

  test('what the dump cannot spell is named: statistics, forced RLS, storage, an unpopulated view', async () => {
    await apply(`
      create table facts (id int primary key, a int, b text);
      alter table facts enable row level security;
      alter table facts force row level security;
      create statistics facts_ab on a, b from facts;
      alter table facts alter column b set storage external;
      create materialized view empty_counts as select count(*) as n from facts with no data;
      create materialized view full_counts as select count(*) as n from facts;
    `);
    const named = await unrendered();
    expect(named).toContain('extended statistics facts_ab on facts');
    expect(named).toContain('forced row security facts on facts');
    expect(named).toContain('column storage b on facts');
    expect(named).toContain('unpopulated materialized view empty_counts');
    // Only the departures: a default storage and a populated view are what the dump already says.
    expect(named.filter((line) => line.startsWith('column storage'))).toHaveLength(1);
    expect(named.join('\n')).not.toContain('full_counts');
  });
});
