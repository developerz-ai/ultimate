// Load equals replay, for the reference app's own migrations: a database built by loading the
// dump and one built by replaying every migration must dump to the same bytes. On the embedded
// database always — the engine the `drift` step replays on — and on a real Postgres when
// `TEST_DATABASE_URL` names one, in a database this file creates and drops.
//
// The migrations are read as TEXT from `examples/dummy`. No import: this package is tier 1 and
// the app is above every tier; a file on disk is data.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path joiner, and the migrations are found relative to this file.
import { join } from 'node:path';
import { type DbClient, postgresClient } from './client';
import { introspectCatalog } from './introspect-catalog';
import { type Migration, migrate } from './migrate';
import { pgliteClient } from './pglite';
import { renderSchemaDump, type SchemaDumpFile } from './schema-dump';
import { loadSchemaDump } from './schema-load';
import { raw } from './sql';

const MIGRATIONS = join(import.meta.dir, '../../../examples/dummy/packages/db/migrations');
const DUMPED_TABLES = join(import.meta.dir, '../../../examples/dummy/packages/db/schema/04_tables');
const DOWN = /^[ \t]*--[ \t]*down[ \t]*$/im;
const BOOT_MS = 60_000;

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

async function referenceMigrations(): Promise<readonly Migration[]> {
  const names: string[] = [];
  for await (const name of new Bun.Glob('*.sql').scan({ cwd: MIGRATIONS })) names.push(name);
  names.sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    const text = await Bun.file(join(MIGRATIONS, name)).text();
    const marker = DOWN.exec(text);
    const id = name.replace(/\.sql$/, '');
    migrations.push({
      id,
      name: id,
      up: (marker === null ? text : text.slice(0, marker.index)).trim(),
      down: '',
    });
  }
  return migrations;
}

/** The app's tables as its committed dump names them — a count written here went stale with each new table. */
async function committedTables(): Promise<readonly string[]> {
  const paths: string[] = [];
  for await (const name of new Bun.Glob('*.sql').scan({ cwd: DUMPED_TABLES })) {
    paths.push(`04_tables/${name}`);
  }
  return paths.sort();
}

const appTables = (files: readonly SchemaDumpFile[]): readonly string[] =>
  files
    .map((file) => file.path)
    .filter((path) => path.startsWith('04_tables/'))
    .sort();

const dump = async (client: DbClient): Promise<readonly SchemaDumpFile[]> =>
  renderSchemaDump(await introspectCatalog({ client }));

/** Replay, dump, empty the schema, load the dump, dump again. Both dumps come back. */
async function replayThenLoad(client: DbClient): Promise<{
  readonly replayed: readonly SchemaDumpFile[];
  readonly loaded: readonly SchemaDumpFile[];
}> {
  await migrate({ migrations: await referenceMigrations(), client });
  const replayed = await dump(client);
  await client.execute(raw('drop schema public cascade'));
  await client.execute(raw('create schema public'));
  await loadSchemaDump({ client, files: replayed });
  return { replayed, loaded: await dump(client) };
}

describe('load(dump) equals replay(migrations) · the reference app', () => {
  test(
    'on the embedded database',
    async () => {
      const client = pgliteClient();
      try {
        const { replayed, loaded } = await replayThenLoad(client);
        // Not vacuous: every table the app's dump names, and the ledger, are there to be compared.
        const tables = await committedTables();
        expect(tables.length).toBeGreaterThan(5);
        expect(appTables(replayed)).toEqual(tables);
        expect(replayed.map((file) => file.path)).toContain('framework/04_tables/x_migrations.sql');
        expect(loaded).toEqual(replayed);
      } finally {
        await client.close();
      }
    },
    BOOT_MS,
  );

  describe.skipIf(!hasPostgres)('on Postgres', () => {
    const database = `x_schema_load_${process.pid}`;
    const admin = postgresClient({ url: url ?? '' });

    afterAll(async () => {
      await admin.execute(raw(`drop database if exists ${database} with (force)`));
      await admin.close();
    });

    test(
      'in a database of its own',
      async () => {
        await admin.execute(raw(`drop database if exists ${database} with (force)`));
        await admin.execute(raw(`create database ${database} template template0`));
        const target = new URL(url ?? '');
        target.pathname = `/${database}`;
        const client = postgresClient({ url: target.toString() });
        try {
          const { replayed, loaded } = await replayThenLoad(client);
          expect(appTables(replayed)).toEqual(await committedTables());
          expect(loaded).toEqual(replayed);
        } finally {
          await client.close();
        }
      },
      BOOT_MS,
    );
  });
});
