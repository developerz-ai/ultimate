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
import { checkSchemaDump, type SchemaReplay } from './schema-dump-drift';

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
