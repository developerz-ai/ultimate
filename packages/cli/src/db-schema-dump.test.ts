// The scratch replay, for real, ONCE: framework tables + migrations on an embedded database,
// rendered, emptied, loaded back and rendered again. One boot covers the whole producer — the
// framework twin, an extension, load equals replay — because a boot is seconds and every other
// test of the dump injects this function's result instead of paying for it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { dbPanel, staticDevSources } from '@ultimat3/admin/dev';
import type { Migration } from '@ultimat3/db';
import type { SchemaDumpFile } from '@ultimat3/db/schema-dump';
import { readSchemaDump, replaySchema, SCHEMA_DUMP_DIR, writeSchemaDump } from './db-schema-dump';
import { frameworkTableNames } from './framework-schema';
import { migrationExtensions } from './migration-extensions';

// A WASM compile, an initdb, the framework's DDL, a replay and a reload. A hang detector.
const REPLAY_MS = 120_000;

const migration = (id: string, up: string): Migration => ({ id, name: id, up, down: '' });

describe('migrationExtensions', () => {
  test('every spelling of create extension, once each, sorted', () => {
    const migrations = [
      migration('1', 'CREATE EXTENSION IF NOT EXISTS citext;\ncreate extension "uuid-ossp";'),
      migration('2', 'create extension citext; create table t (id int);'),
    ];
    expect(migrationExtensions(migrations)).toEqual(['citext', 'uuid-ossp']);
  });

  test('a migration that creates none names none', () => {
    expect(migrationExtensions([migration('1', 'create table t (id int);')])).toEqual([]);
  });
});

describe('replaySchema · the real embedded database', () => {
  test(
    'framework tables under framework/, the app’s beside them, an extension, and load equals replay',
    async () => {
      const replayed = await replaySchema(
        [
          migration(
            '0001_init',
            `create extension citext;
             create table accounts (
               id uuid primary key,
               email citext not null,
               owner_id uuid references x_users (id)
             );`,
          ),
        ],
        { reload: true },
      );
      const paths = replayed.files.map((file) => file.path);
      expect(paths).toContain('01_extensions/citext.sql');
      expect(paths).toContain('04_tables/accounts.sql');
      // The foreign key into the framework's table is why its twin loads first.
      expect(paths).toContain('06_foreign_keys/accounts.sql');
      // `FRAMEWORK_SCHEMA` is their one source: every table it creates has a file, and so does
      // the ledger `migrate()` created. Nothing of the framework's leaks beside the app's.
      for (const table of [...frameworkTableNames(), 'x_migrations']) {
        expect(paths).toContain(`framework/04_tables/${table}.sql`);
      }
      expect(paths.filter((path) => path.startsWith('04_tables/'))).toEqual([
        '04_tables/accounts.sql',
      ]);
      const accounts = replayed.files.find((file) => file.path === '04_tables/accounts.sql');
      expect(accounts?.content).toContain('"email" citext not null');
      // The extension's own 50-odd functions are not app schema.
      expect(paths.some((path) => path.startsWith('08_functions/'))).toBe(false);
      expect(replayed.catalog.unrendered).toEqual([]);
      expect(replayed.reload).toEqual([]);
    },
    REPLAY_MS,
  );
});

describe('SCHEMA_DUMP_DIR', () => {
  // `@ultimat3/admin` sits below this package and cannot import the constant, so its `/_x`
  // database panel repeats the path. This is what keeps the repeat from becoming a second answer.
  test('is the directory the /_x database panel points at', async () => {
    const data = await dbPanel.data(staticDevSources({}), new URLSearchParams());
    expect(data.schemaDump.directory).toBe(SCHEMA_DUMP_DIR);
  });
});

describe('writeSchemaDump', () => {
  let root = '';
  const files: readonly SchemaDumpFile[] = [
    { path: '04_tables/posts.sql', content: 'a\n' },
    { path: 'framework/04_tables/x_jobs.sql', content: 'b\n' },
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'x-dump-write-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('writes what differs, leaves what matches untouched, deletes what nothing renders', async () => {
    expect(await readSchemaDump(root)).toEqual([]);
    const first = await writeSchemaDump(root, files);
    expect(first).toEqual({
      written: files.map((file) => `${SCHEMA_DUMP_DIR}/${file.path}`),
      removed: [],
      total: 2,
    });
    expect(await readSchemaDump(root)).toEqual([...files]);

    const kept = Bun.file(join(root, SCHEMA_DUMP_DIR, '04_tables/posts.sql'));
    const before = kept.lastModified;
    const second = await writeSchemaDump(root, [
      files[0] ?? expect.unreachable(),
      { path: '05_indexes/posts.sql', content: 'c\n' },
    ]);
    expect(second).toEqual({
      written: [`${SCHEMA_DUMP_DIR}/05_indexes/posts.sql`],
      removed: [`${SCHEMA_DUMP_DIR}/framework/04_tables/x_jobs.sql`],
      total: 2,
    });
    // An unchanged table keeps its mtime: a one-table migration is a one-file write.
    expect(Bun.file(join(root, SCHEMA_DUMP_DIR, '04_tables/posts.sql')).lastModified).toBe(before);
    expect((await readSchemaDump(root)).map((file) => file.path)).toEqual([
      '04_tables/posts.sql',
      '05_indexes/posts.sql',
    ]);
  });

  test('only .sql is the dump: a stray file in the directory is neither read nor deleted', async () => {
    await writeSchemaDump(root, files);
    const stray = join(root, SCHEMA_DUMP_DIR, 'NOTES.md');
    await Bun.write(stray, 'mine\n');
    await writeSchemaDump(root, files.slice(0, 1));
    expect(await Bun.file(stray).exists()).toBe(true);
    expect((await readSchemaDump(root)).map((file) => file.path)).toEqual(['04_tables/posts.sql']);
  });
});
