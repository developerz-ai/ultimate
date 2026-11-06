// Single responsibility: a PARTITIONED table in the schema dump — rendered, not named in
// `unrendered.sql`: the parent with its `partition by`, each partition `partition of … for values`
// in the parent's own file, a sub-partition after its parent, and no partition's cloned index, key
// or trigger rendered twice. Load equals replay on the real embedded database.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { introspectCatalog } from './introspect-catalog';
import { pgliteClient } from './pglite';
import { renderSchemaDump, type SchemaDumpFile } from './schema-dump';
import { loadSchemaDump } from './schema-load';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const PGLITE_BOOT_MS = 60_000;

// The child names sort BEFORE their parent (`a_` < `events`) on purpose: a dump in name order
// would create a partition before the table it is a partition of.
const SCHEMA = `
  create table orgs (id uuid primary key);
  create table events (
    id uuid not null,
    org_id uuid not null,
    at date not null,
    kind text not null,
    constraint events_kind_present check (kind <> ''),
    primary key (id, at)
  ) partition by range (at);
  create index events_kind_idx on events (kind);
  alter table events add constraint events_org_fkey foreign key (org_id) references orgs (id);
  create table a_2026_11 partition of events for values from ('2026-11-01') to ('2026-12-01');
  create table a_2026_12 partition of events
    for values from ('2026-12-01') to ('2027-01-01') partition by range (at);
  create table a_2026_12_early partition of a_2026_12
    for values from ('2026-12-01') to ('2026-12-16');
  create table a_rest partition of events default;
  create index a_2026_11_local_idx on a_2026_11 (org_id);
  create function refuse() returns trigger language plpgsql as $$ begin return null; end $$;
  create trigger events_refuse before update on events for each row execute function refuse();
  create table notes (
    id uuid primary key,
    event_id uuid not null,
    event_at date not null,
    constraint notes_event_fkey foreign key (event_id, event_at) references events (id, at)
  );
`;

describe('the schema dump · a partitioned table', () => {
  const client = pgliteClient();
  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const reset = (): Promise<void> => apply('drop schema public cascade; create schema public;');
  const dump = async (): Promise<readonly SchemaDumpFile[]> =>
    renderSchemaDump(await introspectCatalog({ client }));
  const file = (files: readonly SchemaDumpFile[], path: string): string =>
    files.find((entry) => entry.path === path)?.content ?? '';

  beforeEach(async () => {
    await reset();
    await apply(SCHEMA);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('the parent and every partition, in one file, parent first', async () => {
    const files = await dump();
    const tables = files.map((entry) => entry.path).filter((path) => path.startsWith('04_'));
    expect(tables).toEqual(['04_tables/events.sql', '04_tables/notes.sql', '04_tables/orgs.sql']);
    // Each statement's first line, past the file's header comment.
    const statements = statementsOf(file(files, '04_tables/events.sql')).map(
      (s) => s.replace(/^(?:\s*--[^\n]*\n)+\s*/, '').split('\n')[0],
    );
    expect(statements).toEqual([
      'create table "events" (',
      'create table "a_2026_11" partition of "events" FOR VALUES FROM (\'2026-11-01\') TO (\'2026-12-01\')',
      'create table "a_2026_12" partition of "events" FOR VALUES FROM (\'2026-12-01\') TO (\'2027-01-01\') partition by RANGE (at)',
      'create table "a_rest" partition of "events" DEFAULT',
      'create table "a_2026_12_early" partition of "a_2026_12" FOR VALUES FROM (\'2026-12-01\') TO (\'2026-12-16\')',
    ]);
    expect(file(files, '04_tables/events.sql')).toContain(') partition by RANGE (at);');
  });

  test("a partition's clones are not rendered; its own index is", async () => {
    const files = await dump();
    const indexes = files.filter((entry) => entry.path.startsWith('05_')).map((e) => e.content);
    expect(indexes.join('')).toContain('CREATE INDEX events_kind_idx ON public.events');
    expect(indexes.join('')).not.toContain('ON ONLY');
    expect(indexes.join('')).toContain('a_2026_11_local_idx');
    expect(indexes.join('')).not.toContain('a_2026_11_kind_idx');
    const keys = files.filter((entry) => entry.path.startsWith('06_')).map((e) => e.content);
    expect(keys.join('')).not.toContain('_fkey_1');
    expect(keys.join('')).not.toContain('"a_2026_11"');
    expect(files.map((entry) => entry.path).filter((path) => path.startsWith('09_'))).toEqual([
      '09_triggers/events.sql',
    ]);
  });

  test('nothing of it is named in unrendered.sql', async () => {
    expect((await introspectCatalog({ client })).unrendered).toEqual([]);
  });

  test('load equals replay', async () => {
    const before = await dump();
    await reset();
    await loadSchemaDump({ client, files: before });
    expect(await dump()).toEqual(before);
    const kinds = await client.query<{ name: string; kind: string; partition: boolean }>(
      raw(
        `select relname as name, relkind as kind, relispartition as partition from pg_class ` +
          `where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`,
      ),
    );
    expect(kinds.map((row) => `${row.name}:${row.kind}:${row.partition}`)).toEqual([
      'a_2026_11:r:true',
      'a_2026_12:p:true',
      'a_2026_12_early:r:true',
      'a_rest:r:true',
      'events:p:false',
      'notes:r:false',
      'orgs:r:false',
    ]);
  });
});
