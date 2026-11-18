// Single responsibility: the schema dump end to end against the real embedded database — the
// three properties the gate depends on (same database same bytes, a one-column change is a
// one-file diff, every object kind loads back to itself). A recording client cannot prove any of
// them: they are statements about what Postgres answers. The pure half: schema-dump-render.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, no directory listing and no recursive remove.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { DbError } from './errors';
import { introspectCatalog } from './introspect-catalog';
import { type PgliteModule, pgliteClient } from './pglite';
import { PGLITE_PACKAGE } from './pglite-package';
import {
  renderSchemaDump,
  SCHEMA_DUMP_HEADER,
  SCHEMA_DUMP_KINDS,
  type SchemaDumpFile,
} from './schema-dump';
import { loadSchemaDump } from './schema-load';
import { raw, sql } from './sql';
import { statementsOf } from './statement-split';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

/** One object of every kind the dump renders, named so no two sort the way they were created. */
const SCHEMA = `
  create type mood as enum ('sad', 'ok', 'happy');
  create domain slug as text not null default 'x' constraint slug_shape check (value ~ '^[a-z]+$');
  create sequence ticket_seq start with 100 increment by 5;
  create table orgs (
    id uuid primary key,
    name varchar(120) not null,
    plan text not null default 'free',
    created_at timestamptz not null default now()
  );
  create table posts (
    id bigserial primary key,
    org_id uuid not null references orgs (id) on delete cascade,
    n int generated always as identity,
    title text not null,
    s slug,
    m mood not null default 'ok',
    price numeric(12, 2),
    tags text[] not null default '{}',
    search text generated always as (lower(title)) stored,
    constraint posts_title_check check (char_length(title) >= 1),
    constraint posts_org_title_key unique (org_id, title)
  );
  create index posts_org_idx on posts (org_id, id desc) where title <> '';
  create unique index orgs_name_key on orgs (name);
  alter table orgs replica identity using index orgs_name_key;
  alter table posts replica identity full;
  create view post_titles as select id, title from posts where title <> '';
  create materialized view post_counts as select org_id, count(*) as n from posts group by org_id;
  create index post_counts_idx on post_counts (org_id);
  create function touch() returns trigger language plpgsql as
    $$ begin new.title := new.title; return new; end $$;
  create trigger posts_touch before update on posts for each row execute function touch();
  alter table posts enable row level security;
  alter table posts force row level security;
  create policy posts_tenant on posts
    using (org_id = nullif(current_setting('x.tenant', true), '')::uuid)
    with check (org_id = nullif(current_setting('x.tenant', true), '')::uuid);
  create policy posts_titled on posts as restrictive for select to public using (title <> '');
`;

const paths = (files: readonly SchemaDumpFile[]): readonly string[] => files.map((f) => f.path);

describe('the schema dump · the real embedded database', () => {
  // ONE boot for every database-backed assertion about the catalog, the dump and the loader: a
  // boot is seconds of WASM compile and initdb, and three files each paying it bought nothing.
  // Booted WITH a snapshot directory, so the one `initdb` this file pays also writes the cache
  // the last block restores from.
  const cache = mkdtempSync(join(tmpdir(), 'x-schema-dump-cache-'));
  const client = pgliteClient({ snapshotDir: cache });
  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const dump = async (): Promise<readonly SchemaDumpFile[]> =>
    renderSchemaDump(await introspectCatalog({ client }));
  const reset = (): Promise<void> => apply('drop schema public cascade; create schema public;');

  afterAll(async () => {
    await client.close();
    rmSync(cache, { recursive: true, force: true });
  });

  describe('one object of every kind', () => {
    beforeAll(async () => {
      await reset();
      await apply(SCHEMA);
    }, PGLITE_BOOT_MS);

    test('two dumps of one database are byte-identical', async () => {
      expect(await dump()).toEqual(await dump());
    });

    test('every object kind has its directory, in dependency order', async () => {
      const kinds = [...new Set(paths(await dump()).map((path) => path.split('/')[0]))];
      // No extension: PGlite ships none it can create without being built with it.
      expect(kinds).toEqual(SCHEMA_DUMP_KINDS.filter((kind) => kind !== '01_extensions'));
    });

    // Round-tripping proves the dump agrees with itself; this proves it says what the table IS.
    // A reader that stopped reading CHECK constraints would round-trip perfectly without it.
    test('a table file, byte for byte', async () => {
      const posts = (await dump()).find((file) => file.path === '04_tables/posts.sql');
      expect(posts?.content).toBe(
        [
          SCHEMA_DUMP_HEADER,
          '',
          'create sequence "posts_id_seq" as bigint start with 1 increment by 1 minvalue 1 maxvalue 9223372036854775807 cache 1 no cycle;',
          '',
          'create table "posts" (',
          `  "id" bigint default nextval('posts_id_seq'::regclass) not null,`,
          '  "org_id" uuid not null,',
          '  "n" integer generated always as identity (sequence name "posts_n_seq" start with 1 increment by 1 minvalue 1 maxvalue 2147483647 cache 1 no cycle) not null,',
          '  "title" text not null,',
          '  "s" slug,',
          `  "m" mood default 'ok'::mood not null,`,
          '  "price" numeric(12,2),',
          `  "tags" text[] default '{}'::text[] not null,`,
          '  "search" text generated always as (lower(title)) stored,',
          '  constraint "posts_pkey" PRIMARY KEY (id),',
          '  constraint "posts_org_title_key" UNIQUE (org_id, title),',
          '  constraint "posts_title_check" CHECK ((char_length(title) >= 1))',
          ');',
          '',
          'alter sequence "posts_id_seq" owned by "posts"."id";',
          '',
          'alter table "posts" replica identity full;',
          '',
        ].join('\n'),
      );
    });

    test('a renamed column changes exactly one file', async () => {
      const before = await dump();
      await client.execute(raw('alter table orgs rename column plan to tier'));
      const after = await dump();
      await client.execute(raw('alter table orgs rename column tier to plan'));
      const changed = after.filter(
        (file) => before.find((old) => old.path === file.path)?.content !== file.content,
      );
      expect(paths(after)).toEqual(paths(before));
      expect(paths(changed)).toEqual(['04_tables/orgs.sql']);
    });

    test('each object kind round-trips: load(dump) dumps to the same bytes', async () => {
      const before = await dump();
      await reset();
      const report = await loadSchemaDump({ client, files: before });
      expect(report.files).toBe(before.length);
      expect(await dump()).toEqual(before);
      // The loaded database WORKS, not merely describes itself the same: the serial default, the
      // identity, the generated column and the trigger all fire.
      await client.execute(raw("insert into orgs (id, name) values (gen_random_uuid(), 'acme')"));
      await client.execute(raw("insert into posts (org_id, title) select id, 'Hello' from orgs"));
      const rows = await client.query<{ id: string; n: number; search: string }>(
        raw('select id::text as id, n, search from posts'),
      );
      expect(rows).toEqual([{ id: '1', n: 1, search: 'hello' }]);
    });
  });

  describe('loadSchemaDump', () => {
    beforeEach(reset, PGLITE_BOOT_MS);

    test('a view over a later-sorted view and a default calling a function still load', async () => {
      // Both are dependencies AGAINST path order: `04_tables` runs before `08_functions`, and
      // `07_views/a_summary` before `07_views/z_base`.
      await apply(`
        create function next_code() returns text language sql as $$ select 'c' $$;
        create table codes (id int primary key, code text not null default next_code());
        create view z_base as select id, code from codes;
        create view a_summary as select count(*) as n from z_base;
      `);
      const before = await dump();
      await apply('drop schema public cascade; create schema public;');
      const report = await loadSchemaDump({ client, files: before });
      expect(report).toEqual({ files: 4, statements: 4 });
      expect(await dump()).toEqual(before);
    });

    test('a file that never becomes loadable is X_SCHEMA_DUMP_DRIFT naming it, and nothing is left behind', async () => {
      // `no_such_type` is "not created yet" (42704), so the file is deferred — and refused once a
      // whole pass loads nothing more.
      const files = [
        { path: '04_tables/ok.sql', content: 'create table ok (id int);\n' },
        { path: '04_tables/broken.sql', content: 'create table broken (id no_such_type);\n' },
      ];
      const refusal = await loadSchemaDump({ client, files }).catch((error: unknown) => error);
      if (!(refusal instanceof DbError)) expect.unreachable('the load must refuse');
      expect(refusal.code).toBe('X_SCHEMA_DUMP_DRIFT');
      expect(refusal.cause).toStartWith('schema dump file 04_tables/broken.sql does not load: ');
      expect(refusal.cause).toContain('no_such_type');
      expect(refusal.fix).toStartWith('x db gen');
      // One transaction: the table that DID load went with the one that did not.
      expect((await introspectCatalog({ client })).tables).toEqual([]);
    });

    test('a statement the database rejects outright names its file too', async () => {
      const files = [
        { path: '04_tables/bad.sql', content: 'create table bad (id int, id int);\n' },
      ];
      const refusal = await loadSchemaDump({ client, files }).catch((error: unknown) => error);
      if (!(refusal instanceof DbError)) expect.unreachable('the load must refuse');
      expect(refusal.meta).toEqual({ kind: 'unloadable', path: '04_tables/bad.sql' });
      expect(refusal.cause).toContain('specified more than once');
    });
  });

  describe('introspectCatalog', () => {
    beforeAll(async () => {
      await reset();
      await apply(`
      create table b_table (id int primary key, note text not null);
      create table "A_table" (id int primary key);
      create table a_table (id int primary key);
      create table events (id int, at date) partition by range (at);
      create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
      create table parent (id int);
      create table child () inherits (parent);
      create type pair as (a int, b int);
      alter table b_table enable row level security;
      create policy only_mine on b_table using (id > 0);
      create rule quiet as on delete to b_table do instead nothing;
      create table ext_owned (id int primary key);
      create function ext_fn() returns int language sql as $$ select 1 $$;
      create function ext_trg() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger ext_touch before insert on ext_owned for each row execute function ext_trg();
      create unique index b_note_key on b_table (note);
      alter table b_table replica identity using index b_note_key;
      `);
      // The row `create extension` writes for an object it owns — by hand, as
      // `introspect-embedded.test.ts` does, because PGlite ships no contrib extension to install.
      await client.execute(sql`
      insert into pg_depend (classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype)
      select 'pg_class'::regclass, 'ext_owned'::regclass, 0, 'pg_extension'::regclass, e.oid, 0, 'e'
      from pg_extension e where e.extname = 'plpgsql'
      `);
      await client.execute(sql`
      insert into pg_depend (classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype)
      select 'pg_proc'::regclass, 'ext_fn'::regproc, 0, 'pg_extension'::regclass, e.oid, 0, 'e'
      from pg_extension e where e.extname = 'plpgsql'
      `);
      await client.execute(sql`
      insert into pg_depend (classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype)
      select 'pg_proc'::regclass, 'ext_trg'::regproc, 0, 'pg_extension'::regclass, e.oid, 0, 'e'
      from pg_extension e where e.extname = 'plpgsql'
      `);
    }, PGLITE_BOOT_MS);

    test('tables answer in code-unit order, the same on every server', async () => {
      const catalog = await introspectCatalog({ client });
      // An `en_US` collation puts `a_table` before `A_table`; a `C` one the reverse. JS decides.
      expect(catalog.tables.map((table) => table.name)).toEqual([
        'A_table',
        'a_table',
        'b_table',
        'events',
        'events_2026',
        'parent',
      ]);
    });

    test('what the dump cannot spell is named, never rendered as a plain table', async () => {
      const catalog = await introspectCatalog({ client });
      expect(catalog.unrendered).toEqual([
        { kind: 'composite type', name: 'pair', table: null },
        // A partitioned table and its partitions are rendered (`schema-dump-partitioned.test.ts`).
        { kind: 'inheritance child', name: 'child', table: null },
        { kind: 'rule', name: 'quiet', table: 'b_table' },
      ]);
      // Row security is rendered now (`catalog-policies.ts`), so it is read, never named here.
      expect(catalog.rowSecurity).toEqual([{ table: 'b_table', enabled: true, forced: false }]);
      expect(catalog.policies.map((policy) => policy.name)).toEqual(['only_mine']);
    });

    test('an object an extension owns is not app schema', async () => {
      const catalog = await introspectCatalog({ client });
      expect(catalog.tables.map((table) => table.name)).not.toContain('ext_owned');
      expect(catalog.functions).toEqual([]);
      // A trigger on a table the dump never creates would be a `09_triggers/` file that cannot load.
      expect(catalog.triggers).toEqual([]);
      // `plpgsql` itself is left out: every database has it.
      expect(catalog.extensions).toEqual([]);
    });

    test('a replica identity that names an index is read with the index it names', async () => {
      const catalog = await introspectCatalog({ client });
      const table = catalog.tables.find((candidate) => candidate.name === 'b_table');
      expect(table?.replicaIdentity).toEqual({ kind: 'index', index: 'b_note_key' });
      expect(catalog.indexes.map((index) => index.name)).toEqual(['b_note_key']);
    });

    // The hand-written rows make these objects an extension's: left behind, the next
    // `drop schema public cascade` takes `plpgsql` down with them, for every later block.
    afterAll(async () => {
      await client.execute(sql`
      delete from pg_depend
      where refclassid = 'pg_extension'::regclass and deptype = 'e'
        and objid in ('ext_owned'::regclass::oid, 'ext_fn'::regproc::oid, 'ext_trg'::regproc::oid)
      `);
      await client.execute(raw('drop schema if exists other cascade'));
    });

    test('another schema is another catalog', async () => {
      await client.execute(raw('create schema other'));
      await client.execute(raw('create table other.only_here (id int primary key)'));
      const other = await introspectCatalog({ client, schema: 'other' });
      expect(other.schema).toBe('other');
      expect(other.tables.map((table) => table.name)).toEqual(['only_here']);
      expect(other.unrendered).toEqual([]);
    });
  });
  describe('a boot restored from the snapshot', () => {
    // The REAL PGlite, wrapped only to see what its constructor was handed. This is the proof
    // the cache key stands on: a snapshot written by a boot that linked nothing restores under a
    // boot that links `citext`, and the extension can then be created and dumped.
    // The file's own client boots first, whichever block ran before: that boot writes the snapshot.
    beforeAll(async () => {
      await client.execute(raw('select 1'));
    }, PGLITE_BOOT_MS);

    test(
      'links an extension the snapshot never saw, creates it, and dumps it',
      async () => {
        const handed: unknown[] = [];
        const restored = pgliteClient({
          snapshotDir: cache,
          extensions: ['citext'],
          load: async () => {
            const real = (await import(PGLITE_PACKAGE)) as PgliteModule;
            return {
              PGlite: class extends real.PGlite {
                constructor(
                  dataDir?: string,
                  options?: ConstructorParameters<PgliteModule['PGlite']>[1],
                ) {
                  handed.push(options);
                  super(dataDir, options);
                }
              },
            };
          },
        });
        try {
          await restored.execute(raw('create extension citext'));
          await restored.execute(raw('create table accounts (email citext primary key)'));
          // One construction, and it was a restore: no `initdb` ran for this client.
          expect(handed).toHaveLength(1);
          expect(handed[0]).toHaveProperty('loadDataDir');
          const files = renderSchemaDump(await introspectCatalog({ client: restored }));
          expect(paths(files)).toEqual(['01_extensions/citext.sql', '04_tables/accounts.sql']);
          expect(files[0]?.content).toEndWith('create extension if not exists "citext";\n');
          // At most one file, whoever wrote it: when another test file in this process already
          // holds the snapshot in memory, the first client restored too and wrote nothing.
          expect(readdirSync(cache).length).toBeLessThanOrEqual(1);
        } finally {
          await restored.close();
        }
      },
      PGLITE_BOOT_MS,
    );
  });
});
