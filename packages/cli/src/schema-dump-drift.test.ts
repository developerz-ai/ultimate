// The `drift` step's dump rail, with the replay injected: what is and is not `X_SCHEMA_DUMP_DRIFT`,
// and where each finding points. That the real replay produces the committed bytes is asserted
// against the two tracked apps by the gate itself, and end to end in `cmd-db.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { dbUnavailable } from '@ultimat3/db';
import {
  emptyCatalog,
  reloadDifferences,
  type SchemaDumpDifference,
  type SchemaDumpFile,
} from '@ultimat3/db/schema-dump';
import { SCHEMA_DUMP_DIR, writeSchemaDump } from './db-schema-dump';
import { MIGRATIONS_DIR } from './migrations';
import type { DeclaredEntities } from './schema-drift';
import {
  checkSchemaDump,
  type SchemaReplay,
  undeclaredIndexFindings,
  undeclaredIndexWarnings,
} from './schema-dump-drift';

const FILES: readonly SchemaDumpFile[] = [
  { path: '04_tables/posts.sql', content: 'create table "posts" ("id" uuid);\n' },
  { path: '05_indexes/posts.sql', content: 'CREATE INDEX posts_idx ON public.posts (id);\n' },
];

const replaying =
  (files: readonly SchemaDumpFile[], reload: readonly SchemaDumpDifference[] = []): SchemaReplay =>
  async () => ({ catalog: emptyCatalog(), files, reload });

describe('checkSchemaDump', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'x-dump-drift-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** `packages/db` existing is what makes this an app with a schema at all. */
  const withMigration = (): Promise<number> =>
    Bun.write(join(root, MIGRATIONS_DIR, '0001_init.sql'), 'create table posts (id uuid);\n');

  let replays = 0;
  const counting: SchemaReplay = (migrations) => {
    replays += 1;
    return replaying(FILES)(migrations);
  };

  test('no packages/db, or one with no migration and no dump: nothing owed, nothing replayed', async () => {
    replays = 0;
    expect(await checkSchemaDump(root, {}, counting)).toEqual([]);
    await Bun.write(join(root, 'packages/db/src/schema.ts'), 'export {};\n');
    expect(await checkSchemaDump(root, {}, counting)).toEqual([]);
    expect(replays).toBe(0);
  });

  test('a migration and no dump: one finding naming x db gen, and still no database', async () => {
    replays = 0;
    await withMigration();
    expect(await checkSchemaDump(root, {}, counting)).toEqual([
      {
        code: 'X_SCHEMA_DUMP_DRIFT',
        cause: `${MIGRATIONS_DIR} holds migrations and ${SCHEMA_DUMP_DIR} does not exist: the schema dump was never generated`,
        fix: 'x db gen',
        docs: ERROR_DOCS_URL,
        at: SCHEMA_DUMP_DIR,
      },
    ]);
    expect(replays).toBe(0);
  });

  test('the committed dump is what the migrations produce: clean', async () => {
    await writeSchemaDump(root, FILES);
    expect(await checkSchemaDump(root, {}, replaying(FILES))).toEqual([]);
  });

  test('a hand edit is X_SCHEMA_DUMP_DRIFT at the file, fixed by x db gen', async () => {
    await writeSchemaDump(root, FILES);
    await Bun.write(
      join(root, SCHEMA_DUMP_DIR, '04_tables/posts.sql'),
      'create table "posts" ();\n',
    );
    expect(await checkSchemaDump(root, {}, replaying(FILES))).toEqual([
      {
        code: 'X_SCHEMA_DUMP_DRIFT',
        cause: 'schema dump file 04_tables/posts.sql differs from what the migrations produce',
        fix: 'x db gen',
        docs: ERROR_DOCS_URL,
        at: `${SCHEMA_DUMP_DIR}/04_tables/posts.sql`,
      },
    ]);
  });

  test('a migration nobody regenerated for, and a file nothing renders, are both reported', async () => {
    await writeSchemaDump(root, [...FILES, { path: '04_tables/gone.sql', content: 'x\n' }]);
    const produced = [...FILES, { path: '04_tables/new.sql', content: 'y\n' }];
    const findings = await checkSchemaDump(root, {}, replaying(produced));
    expect(findings.map((finding) => finding.at)).toEqual([
      `${SCHEMA_DUMP_DIR}/04_tables/gone.sql`,
      `${SCHEMA_DUMP_DIR}/04_tables/new.sql`,
    ]);
    expect(findings.every((finding) => finding.code === 'X_SCHEMA_DUMP_DRIFT')).toBe(true);
  });

  test('a dump that does not load back is reported beside a stale file, with its own fix', async () => {
    await writeSchemaDump(root, [FILES[0] ?? expect.unreachable()]);
    const reload = reloadDifferences(FILES, FILES.slice(0, 1));
    const findings = await checkSchemaDump(root, {}, replaying(FILES, reload));
    expect(findings.map((finding) => [finding.at, finding.fix.startsWith('x db gen')])).toEqual([
      [`${SCHEMA_DUMP_DIR}/05_indexes/posts.sql`, true],
      [`${SCHEMA_DUMP_DIR}/05_indexes/posts.sql`, true],
    ]);
    expect(findings[0]?.cause).toContain('is not committed');
    expect(findings[1]?.cause).toContain('comes back different');
    expect(findings[1]?.fix).not.toBe('x db gen');
  });

  test('migrations that will not replay are one finding, not a thrown step', async () => {
    await writeSchemaDump(root, FILES);
    const findings = await checkSchemaDump(root, {}, async () => {
      throw dbUnavailable('relation "missing" does not exist');
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_SCHEMA_DUMP_DRIFT');
    expect(findings[0]?.cause).toContain('relation "missing" does not exist');
    expect(findings[0]?.at).toBe(MIGRATIONS_DIR);
  });
});

// The D2 sequence: edit an applied migration's `up`, run the `x db gen` a fix used to name. The dump
// is what the migrations produce, so the replay above is green over a column nothing declares; only
// the snapshot, written from the entities, still says what the schema was meant to be.
describe('the dump against the newest snapshot', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'x-dump-columns-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = (table: string, columns: readonly string[]): string =>
    JSON.stringify({
      tables: [
        {
          schema: 'public',
          name: table,
          columns: columns.map((name, position) => ({
            name,
            dataType: 'text',
            nullable: true,
            default: null,
            position,
          })),
          primaryKey: [],
          indexes: [],
          foreignKeys: [],
        },
      ],
    });

  const migration = async (id: string, up: string, recorded?: readonly string[]): Promise<void> => {
    await Bun.write(join(root, MIGRATIONS_DIR, `${id}.sql`), `-- ${id}\n${up}\n`);
    if (recorded !== undefined) {
      await Bun.write(
        join(root, MIGRATIONS_DIR, `${id}.snapshot.json`),
        snapshot('posts', recorded),
      );
    }
  };

  const dumpOf = (columns: readonly string[]): readonly SchemaDumpFile[] => [
    {
      path: '04_tables/posts.sql',
      content: [
        '-- generated by `x db gen` from the migrations',
        '',
        'create table "posts" (',
        ...columns.map((name) => `  "${name}" text,`),
        '  constraint "posts_pkey" PRIMARY KEY (id)',
        ');',
        '',
      ].join('\n'),
    },
  ];

  const check = async (dump: readonly SchemaDumpFile[]) => {
    await writeSchemaDump(root, dump);
    return checkSchemaDump(root, {}, replaying(dump));
  };

  test('a dump holding what the snapshot records is clean, constraints and all', async () => {
    await migration('0001_init', 'create table posts (id text);', ['id', 'title']);
    expect(await check(dumpOf(['id', 'title']))).toEqual([]);
  });

  test('a column no snapshot records is X_DB_DRIFT, and the fix restores before it generates', async () => {
    await migration('0001_init', 'create table posts (id text, hacked text);', ['id']);
    const findings = await check(dumpOf(['id', 'hacked']));
    expect(findings.map((finding) => finding.code)).toEqual(['X_DB_DRIFT']);
    expect(findings[0]?.cause).toContain('holds a column no migration');
    expect(findings[0]?.cause).toContain('"hacked"');
    expect(findings[0]?.at).toBe(`${SCHEMA_DUMP_DIR}/04_tables/posts.sql`);
    expect(findings[0]?.fix).toStartWith(
      `git checkout -- ${MIGRATIONS_DIR} ${SCHEMA_DUMP_DIR}   # `,
    );
  });

  test('a recorded column the dump lost is the same drift', async () => {
    await migration('0001_init', 'create table posts (id text);', ['id', 'title']);
    const findings = await check(dumpOf(['id']));
    expect(findings.map((finding) => finding.code)).toEqual(['X_DB_DRIFT']);
    expect(findings[0]?.cause).toContain('"title"');
  });

  test('only the newest snapshot speaks', async () => {
    await migration('0001_init', 'create table posts (id text);', ['id']);
    await migration('0002_add', 'alter table posts add column title text;', ['id', 'title']);
    expect(await check(dumpOf(['id', 'title']))).toEqual([]);
  });

  test('a table hand-written SQL touches is exempt: no snapshot could record it', async () => {
    await migration(
      '0001_init',
      '-- ungeneratable: 1\ncreate table posts (id text);\ncreate rule r as on insert to posts do nothing;\nalter table posts inherit base;',
      ['id'],
    );
    expect(await check(dumpOf(['id', 'inherited']))).toEqual([]);
  });

  test('a newer migration with no sidecar is exempt for the tables it names, and only those', async () => {
    await migration('0001_init', 'create table posts (id text);', ['id']);
    await migration('0002_by_hand', 'alter table "public"."posts" add column extra text;');
    expect(await check(dumpOf(['id', 'extra']))).toEqual([]);
    await Bun.write(
      join(root, MIGRATIONS_DIR, '0002_by_hand.sql'),
      'alter table other add column extra text;\n',
    );
    expect(await check(dumpOf(['id', 'extra']))).toHaveLength(1);
  });

  // Postgres folds an unquoted name to lower case and keeps a quoted one as written.
  test('an unquoted table name is folded as Postgres folds it; a quoted one is not', async () => {
    await migration('0001_init', 'create table posts (id text);', ['id']);
    await migration('0002_by_hand', 'ALTER TABLE POSTS ADD COLUMN extra text;');
    expect(await check(dumpOf(['id', 'extra']))).toEqual([]);
    await Bun.write(
      join(root, MIGRATIONS_DIR, '0002_by_hand.sql'),
      'alter table public."Posts" add column extra text;\n',
    );
    expect(await check(dumpOf(['id', 'extra']))).toHaveLength(1);
  });

  test('no snapshot at all says nothing: the first generation is what writes one', async () => {
    await migration('0001_init', 'create table posts (id text);');
    expect(await check(dumpOf(['id', 'hacked']))).toEqual([]);
  });
});

// A1: the rename migration created each index under its hashed name and recorded the old one as gone
// without dropping it. Every snapshot since agreed with the entities, the dump replayed clean, and
// production maintained seven duplicate indexes. Only the dump said so; nothing read it.
describe('an index in the dump that nothing declares', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'x-dump-indexes-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const index = (name: string) => ({
    name,
    columns: ['author_id'],
    unique: false,
    primary: false,
    where: null,
    order: null,
  });

  const recording = async (indexes: readonly string[]): Promise<void> => {
    await Bun.write(join(root, MIGRATIONS_DIR, '0001_init.sql'), '-- 0001_init\nselect 1;\n');
    await Bun.write(
      join(root, MIGRATIONS_DIR, '0001_init.snapshot.json'),
      JSON.stringify({
        tables: [
          {
            schema: 'public',
            name: 'posts',
            columns: [],
            primaryKey: [],
            indexes: indexes.map(index),
            foreignKeys: [],
          },
        ],
      }),
    );
  };

  const dumping = async (lines: readonly string[]): Promise<void> => {
    await writeSchemaDump(root, [
      { path: '05_indexes/posts.sql', content: `-- generated\n\n${lines.join('\n\n')}\n` },
      {
        path: 'framework/05_indexes/x_jobs.sql',
        content: 'CREATE INDEX x_jobs_due_idx ON public.x_jobs USING btree (run_at);\n',
      },
    ]);
  };

  const declaring =
    (indexes: readonly string[]): DeclaredEntities =>
    async () => [
      { name: 'post', table: 'posts', primaryKey: [], columns: [], indexes: indexes.map(index) },
    ];

  test('a dump with an extra index is X_DB_INDEX_UNDECLARED at its file, naming the drop', async () => {
    await recording(['posts_author_id_08493ec4_idx']);
    await dumping([
      'CREATE INDEX posts_author_id_08493ec4_idx ON public.posts USING btree (author_id DESC);',
      'CREATE INDEX posts_author_id_idx ON public.posts USING btree (author_id DESC);',
    ]);
    const findings = await undeclaredIndexFindings(root, declaring([]));
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_DB_INDEX_UNDECLARED', `${SCHEMA_DUMP_DIR}/05_indexes/posts.sql`],
    ]);
    expect(findings[0]?.cause).toContain('"posts_author_id_idx" on table "posts"');
    expect(findings[0]?.fix).toContain('DROP INDEX CONCURRENTLY IF EXISTS "posts_author_id_idx";');
  });

  test('an index the snapshot or the entities name is declared; a framework table is not judged', async () => {
    await recording(['posts_a_idx']);
    await dumping([
      'CREATE INDEX posts_a_idx ON public.posts USING btree (a);',
      'CREATE UNIQUE INDEX "posts_B_idx" ON public.posts USING btree (b);',
    ]);
    expect(await undeclaredIndexFindings(root, declaring(['posts_B_idx']))).toEqual([]);
    const found = await undeclaredIndexFindings(root, declaring([]));
    expect(found).toHaveLength(1);
    expect(found[0]?.cause).toContain('index "posts_B_idx" on table "posts"');
  });

  test('a registry that did not load judges nothing: "neither" cannot be stated', async () => {
    await recording([]);
    await dumping(['CREATE INDEX posts_extra_idx ON public.posts USING btree (a);']);
    expect(await undeclaredIndexFindings(root, async () => undefined)).toEqual([]);
  });

  test('warnings on main: one line per finding, code first, the fix carried', async () => {
    await recording([]);
    await dumping(['CREATE INDEX posts_extra_idx ON ONLY public.posts USING btree (a);']);
    const warnings = await undeclaredIndexWarnings(root, declaring([]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(
      `X_DB_INDEX_UNDECLARED ${SCHEMA_DUMP_DIR}/05_indexes/posts.sql: `,
    );
    expect(warnings[0]).toContain(' — fix: DROP INDEX CONCURRENTLY IF EXISTS "posts_extra_idx";');
  });
});
