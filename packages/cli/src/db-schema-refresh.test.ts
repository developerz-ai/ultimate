// What `x db gen` and `x db migrate` REPORT about the dump: written, already right, not owed, or
// impossible — and that the last is always a finding. The replay is injected; that the real one
// produces these files is `db-schema-dump.test.ts`'s.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { dbUnavailable, PGLITE_MISSING, PGLITE_PACKAGE } from '@ultimat3/db';
import { emptyCatalog, type SchemaDumpFile } from '@ultimat3/db/schema-dump';
import { readSchemaDump, SCHEMA_DUMP_DIR } from './db-schema-dump';
import {
  dumpNeverGenerated,
  refreshSchemaDump,
  replayFailure,
  schemaDumpJson,
} from './db-schema-refresh';
import { MIGRATIONS_DIR } from './migrations';

const FILES: readonly SchemaDumpFile[] = [
  { path: '04_tables/posts.sql', content: 'create table "posts" ("id" uuid);\n' },
  { path: 'framework/04_tables/x_jobs.sql', content: 'create table "x_jobs" ("id" uuid);\n' },
];

const replaying = (files: readonly SchemaDumpFile[]) => async () => ({
  catalog: emptyCatalog(),
  files,
  reload: [],
});

const refusing = async (): Promise<never> => {
  throw dbUnavailable('extension "vector" is not available');
};

describe('refreshSchemaDump', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'x-dump-refresh-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const withMigration = (): Promise<number> =>
    Bun.write(join(root, MIGRATIONS_DIR, '0001_init.sql'), 'create table posts (id uuid);\n');

  test('no migration and no dump: nothing is replayed, nothing is owed', async () => {
    let replays = 0;
    const refresh = await refreshSchemaDump(root, {}, async () => {
      replays += 1;
      return replaying(FILES)();
    });
    expect(replays).toBe(0);
    expect(refresh).toEqual({ status: 'skipped', total: 0, written: [], removed: [] });
  });

  test('the first refresh writes every file; the second changes nothing', async () => {
    await withMigration();
    const first = await refreshSchemaDump(root, {}, replaying(FILES));
    expect(first.status).toBe('written');
    expect(first.written).toEqual(FILES.map((file) => `${SCHEMA_DUMP_DIR}/${file.path}`));
    expect(first.catalog).toEqual(emptyCatalog());
    expect(await readSchemaDump(root)).toEqual([...FILES]);

    const second = await refreshSchemaDump(root, {}, replaying(FILES));
    expect(second).toMatchObject({ status: 'unchanged', written: [], removed: [], total: 2 });
  });

  test('a file the migrations no longer produce is deleted and reported', async () => {
    await withMigration();
    await refreshSchemaDump(root, {}, replaying(FILES));
    const refresh = await refreshSchemaDump(root, {}, replaying(FILES.slice(1)));
    expect(refresh.status).toBe('written');
    expect(refresh.removed).toEqual([`${SCHEMA_DUMP_DIR}/04_tables/posts.sql`]);
    expect((await readSchemaDump(root)).map((file) => file.path)).toEqual([
      'framework/04_tables/x_jobs.sql',
    ]);
  });

  test('migrations that do not replay are X_SCHEMA_DUMP_DRIFT, dump held or not', async () => {
    await withMigration();
    const never = await refreshSchemaDump(root, {}, refusing);
    expect(never.status).toBe('failed');
    expect(never.finding?.code).toBe('X_SCHEMA_DUMP_DRIFT');
    expect(never.finding?.cause).toContain('extension "vector" is not available');
    expect(never.finding?.at).toBe(MIGRATIONS_DIR);

    await refreshSchemaDump(root, {}, replaying(FILES));
    const held = await refreshSchemaDump(root, {}, refusing);
    expect(held.status).toBe('failed');
    // The held dump is left as it was: a failed regeneration must not delete the last good one.
    expect(await readSchemaDump(root)).toEqual([...FILES]);
  });
});

describe('replayFailure', () => {
  test('keeps the engine’s cause and replaces its fix with one that runs here', () => {
    const finding = replayFailure(dbUnavailable('type "vector" does not exist'));
    expect(finding.cause).toContain('type "vector" does not exist');
    expect(finding.fix).toStartWith('x db migrate --json');
    expect(finding.fix).not.toContain('DATABASE_URL');
  });

  test('an app without the embedded database is told to install it, not to migrate', () => {
    // `x db migrate` against a server would succeed and say nothing about why the dump failed.
    const finding = replayFailure(dbUnavailable(PGLITE_MISSING));
    expect(finding.cause).toContain(PGLITE_MISSING);
    expect(finding.fix).toBe(`bun add -d ${PGLITE_PACKAGE}   # then: x db gen`);
    expect(finding.at).toBe(SCHEMA_DUMP_DIR);
  });

  test('a value that is not an error still renders', () => {
    expect(replayFailure(Object.create(null)).cause).toContain('do not replay');
  });
});

describe('dumpNeverGenerated', () => {
  test('names both directories and the one command', () => {
    expect(dumpNeverGenerated()).toMatchObject({
      code: 'X_SCHEMA_DUMP_DRIFT',
      fix: 'x db gen',
      at: SCHEMA_DUMP_DIR,
    });
    expect(dumpNeverGenerated().cause).toContain(MIGRATIONS_DIR);
  });
});

describe('schemaDumpJson', () => {
  test('the --json shape: a status, a count and the paths that moved', () => {
    expect(schemaDumpJson({ status: 'unchanged', written: [], removed: [], total: 57 })).toEqual({
      directory: SCHEMA_DUMP_DIR,
      status: 'unchanged',
      files: 57,
      written: [],
      removed: [],
    });
  });
});
