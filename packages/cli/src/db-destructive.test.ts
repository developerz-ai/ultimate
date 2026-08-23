// The destructive rail as `x verify` runs it: over real migration files on disk, through the same
// reader `x db migrate` applies from. The round trip is the point — a rail that agreed with the
// classifier but disagreed with the reader would pass here and fail nothing in production.

import { afterAll, describe, expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API, and a fixture tree must exist before the
// gate reads it, so these are the synchronous Node ones. `node:path` — no Bun path joiner.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { DESTRUCTIVE_MARKER, generateMigration } from '@ultimat3/db';
import { APP_CONFIG_FILE } from './app-root';
import { VERIFY_STEPS } from './cmd-verify';
import { checkDestructiveMigrations } from './db-destructive';
import { migrationSql } from './db-generate';
import { MIGRATIONS_DIR } from './migrations';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An app root holding exactly the migration files named. */
async function appWith(files: Readonly<Record<string, string>>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-destructive-'));
  roots.push(root);
  mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    await Bun.write(join(root, MIGRATIONS_DIR, name), sql);
  }
  return root;
}

const CREATE = 'create table "post" (\n  "id" uuid primary key\n);';

describe('unit · the destructive rail', () => {
  test('an undeclared drop is X_MIGRATION_DESTRUCTIVE, naming the file and the statement', async () => {
    const root = await appWith({
      '0002_drop_body.sql': `-- 0002_drop_body\nalter table "post" drop column "body";\n`,
    });
    const [finding, ...rest] = await checkDestructiveMigrations(root);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_MIGRATION_DESTRUCTIVE');
    expect(finding?.at).toBe(`${MIGRATIONS_DIR}/0002_drop_body.sql`);
    expect(finding?.cause).toContain('alter table "post" drop column "body"');
    expect(finding?.fix).toContain(DESTRUCTIVE_MARKER);
    expect(finding?.docs).toBe(ERROR_DOCS_URL);
  });

  test('the marker clears the file', async () => {
    const root = await appWith({
      '0002_drop_body.sql': `${DESTRUCTIVE_MARKER}\nalter table "post" drop column "body";\n`,
    });
    expect(await checkDestructiveMigrations(root)).toEqual([]);
  });

  test('one finding per file, however many statements it drops', async () => {
    const root = await appWith({
      '0002_purge.sql': 'drop table "draft";\nalter table "post" drop column "body";\n',
    });
    const findings = await checkDestructiveMigrations(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('drops a table');
    expect(findings[0]?.cause).toContain('(and 1 more destructive)');
  });

  test('a `down` full of drops is not the migration — only `up` is judged', async () => {
    const root = await appWith({
      '0001_init.sql': `${CREATE}\n\n-- down\ndrop table "post";\n`,
    });
    expect(await checkDestructiveMigrations(root)).toEqual([]);
  });

  test('a `.down.sql` sidecar is not read as a migration of its own', async () => {
    const root = await appWith({
      '0001_init.sql': `${CREATE}\n`,
      '0001_init.down.sql': 'drop table "post";\n',
    });
    expect(await checkDestructiveMigrations(root)).toEqual([]);
  });

  test('every file is judged, in apply order — not just the first or the newest', async () => {
    const root = await appWith({
      '0001_init.sql': `${CREATE}\n`,
      '0002_drop.sql': 'drop table "draft";\n',
      '0003_add.sql': 'alter table "post" add column "slug" text;\n',
      '0004_truncate.sql': 'truncate "post";\n',
    });
    const findings = await checkDestructiveMigrations(root);
    expect(findings.map((finding) => finding.at)).toEqual([
      `${MIGRATIONS_DIR}/0002_drop.sql`,
      `${MIGRATIONS_DIR}/0004_truncate.sql`,
    ]);
  });

  test('an app with no migrations directory has nothing to declare', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-destructive-bare-'));
    roots.push(root);
    expect(await checkDestructiveMigrations(root)).toEqual([]);
  });

  test('what `x db gen --allow-destructive` writes passes the gate it would otherwise fail', async () => {
    const before = {
      tables: [
        {
          schema: 'public',
          name: 'post',
          columns: [
            { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
            { name: 'body', dataType: 'text', nullable: true, default: null, position: 2 },
          ],
          primaryKey: ['id'],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const entities = [
      {
        name: 'Post',
        table: 'post',
        primaryKey: ['id'],
        columns: [
          {
            property: 'id',
            column: 'id',
            kind: 'uuid',
            notNull: true,
            primaryKey: true,
            unique: false,
            hasDefault: false,
            check: null,
            references: null,
          },
        ],
        indexes: [],
      },
    ];
    const migration = generateMigration({
      entities,
      current: before,
      name: 'drop body',
      allowDestructive: true,
    });
    expect(migration.destructive).toBe(true);

    const marked = await appWith({ [`${migration.id}.sql`]: migrationSql(migration) });
    expect(await checkDestructiveMigrations(marked)).toEqual([]);

    // The same SQL without the line the generator wrote is what the rail exists to refuse.
    const bare = await appWith({
      [`${migration.id}.sql`]: migrationSql(migration).replace(`${DESTRUCTIVE_MARKER}\n`, ''),
    });
    expect((await checkDestructiveMigrations(bare))[0]?.code).toBe('X_MIGRATION_DESTRUCTIVE');
  });
});

// The rail only exists if the gate runs it. Reaching into the real step list rather than a stub:
// a check nothing calls is a check that passes forever.
describe('unit · the rail is wired into `x verify`', () => {
  test('the `drift` step reports an undeclared drop', async () => {
    const root = await appWith({ '0002_drop.sql': 'drop table "post";\n' });
    await Bun.write(join(root, APP_CONFIG_FILE), 'export const config = {};\n');

    const drift = VERIFY_STEPS.find((step) => step.name === 'drift');
    expect(await drift?.applies?.({ root, runner: async () => ({}) as never })).toBe(true);
    const result = await drift?.run({ root, runner: async () => ({}) as never });
    expect(result?.ok).toBe(false);
    expect(result?.findings.map((finding) => finding.code)).toContain('X_MIGRATION_DESTRUCTIVE');
  });
});
