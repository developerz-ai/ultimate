// The ungeneratable rail as `x verify` runs it: over real migration files on disk, through the
// same reader `x db migrate` applies from. Both halves are load-bearing — a hand-written statement
// is reported, and REAL `generateMigration` output is not, since a rail that fires on the
// generator's own SQL would be pinned away on its first run and enforce nothing afterwards.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API, and a fixture tree must exist before
// the gate reads it, so these are the synchronous Node ones. `node:path` — no Bun path joiner.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { generateMigration } from '@ultimat3/db';
import { APP_CONFIG_FILE } from './app-root';
import { VERIFY_STEPS } from './cmd-verify';
import { migrationSql } from './db-generate';
import {
  checkUngeneratableMigrations,
  declaredUngeneratable,
  ungeneratableMarker,
} from './db-ungeneratable';
import { MIGRATIONS_DIR } from './migrations';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An app root holding exactly the migration files named. */
async function appWith(files: Readonly<Record<string, string>>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-ungeneratable-'));
  roots.push(root);
  mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    await Bun.write(join(root, MIGRATIONS_DIR, name), sql);
  }
  return root;
}

// A form the generator provably cannot write, and the fixture's whole job is to STAY one. This
// was `alter table … replica identity full` until 2026-08-26, when `GenerateOptions.
// replicaIdentityFull` made that a statement `x db gen` emits — at which point four tests here
// were asserting the rail reports SQL the generator itself writes. A trigger has no entity
// declaration behind it in any shape this framework has, so it cannot be declassified the same way.
const HANDWRITTEN =
  'create trigger posts_audit after update on "posts" for each row execute function audit();';
const ENUM = "create type plan_code as enum ('free', 'team');";

describe('unit · the ungeneratable rail', () => {
  test('an undeclared hand-written statement is X_MIGRATION_UNGENERATABLE, naming file and statement', async () => {
    const root = await appWith({ '0001_init.sql': `-- 0001_init\n${HANDWRITTEN}\n` });

    const [finding, ...rest] = await checkUngeneratableMigrations(root);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_MIGRATION_UNGENERATABLE');
    expect(finding?.at).toBe(`${MIGRATIONS_DIR}/0001_init.sql`);
    expect(finding?.cause).toContain('create trigger posts_audit');
    expect(finding?.fix).toContain(ungeneratableMarker(1));
    expect(finding?.fix).toContain(`${MIGRATIONS_DIR}/0001_init.sql`);
    expect(finding?.docs).toBe(ERROR_DOCS_URL);
  });

  test('the cause carries the count, so a rewrite reads differently from a typo', async () => {
    const root = await appWith({ '0001_init.sql': `-- 0001_init\n${ENUM}\n${HANDWRITTEN}\n` });

    const [finding, ...rest] = await checkUngeneratableMigrations(root);
    // One finding per FILE: the header line declares the whole migration, so a second finding
    // would repeat the instruction the first already gave.
    expect(rest).toEqual([]);
    expect(finding?.cause).toContain('2 statements');
    expect(finding?.cause).toContain('the first of 2');
    expect(finding?.fix).toContain(ungeneratableMarker(2));
  });

  test('the header marker declaring the exact count silences it', async () => {
    const root = await appWith({
      '0001_init.sql': `-- 0001_init\n${ungeneratableMarker(2)}\n\n${ENUM}\n${HANDWRITTEN}\n`,
    });
    expect(await checkUngeneratableMigrations(root)).toEqual([]);
  });

  test('a marker declaring fewer than the file holds still reports, and names both numbers', async () => {
    const root = await appWith({
      '0001_init.sql': `-- 0001_init\n${ungeneratableMarker(1)}\n\n${ENUM}\n${HANDWRITTEN}\n`,
    });
    const [finding] = await checkUngeneratableMigrations(root);
    expect(finding?.code).toBe('X_MIGRATION_UNGENERATABLE');
    expect(finding?.cause).toContain('declares 1');
    expect(finding?.fix).toContain(ungeneratableMarker(2));
  });

  test('a marker below the first statement declares nothing — it is a HEADER line', async () => {
    const root = await appWith({
      '0001_init.sql': `-- 0001_init\n${ENUM}\n${ungeneratableMarker(2)}\n${HANDWRITTEN}\n`,
    });
    expect((await checkUngeneratableMigrations(root))[0]?.code).toBe('X_MIGRATION_UNGENERATABLE');
  });

  test('a marker inside a string, a dollar body or a block comment declares nothing', async () => {
    // The three hiding places `hasDestructiveMarker` was rewritten for. Reading the header run —
    // everything before the first statement, where none of the three can begin — is what makes
    // this answerable here without a second SQL scanner (`@ultimat3/db` owns the only one).
    expect(
      declaredUngeneratable(`insert into notes values ('\n${ungeneratableMarker(9)}\n');`),
    ).toBe(0);
    expect(declaredUngeneratable(`create function f() as $$\n${ungeneratableMarker(9)}\n$$;`)).toBe(
      0,
    );
    expect(declaredUngeneratable(`/*\n${ungeneratableMarker(9)}\n*/\n${HANDWRITTEN}`)).toBe(0);
  });

  test('only `up` is judged: hand SQL under `-- down` reports nothing', async () => {
    const root = await appWith({
      '0001_init.sql': `-- 0001_init\ncreate table "posts" ("id" uuid primary key);\n\n-- down\n${HANDWRITTEN}\n${ENUM}\n`,
    });
    expect(await checkUngeneratableMigrations(root)).toEqual([]);
  });

  test('an app with no migrations directory reports nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-ungeneratable-'));
    roots.push(root);
    expect(await checkUngeneratableMigrations(root)).toEqual([]);
  });

  test('what `x db gen` really writes is never reported', async () => {
    // The no-false-positive half, and it is REAL generator output rather than SQL typed here: a
    // hand-written "generated-looking" corpus proves the test's own opinion of the generator.
    const before = {
      tables: [
        {
          schema: 'public',
          name: 'post',
          columns: [
            { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
            { name: 'price', dataType: 'text', nullable: true, default: null, position: 2 },
          ],
          primaryKey: ['id'],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const migration = generateMigration({
      entities: [
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
            // A retype (`alter column … type`) and a new column (`add column`) in one file.
            {
              property: 'price',
              column: 'price',
              kind: 'bigint',
              notNull: false,
              primaryKey: false,
              unique: false,
              hasDefault: false,
              check: null,
              references: null,
            },
            {
              property: 'slug',
              column: 'slug',
              kind: 'text',
              notNull: true,
              primaryKey: false,
              unique: false,
              hasDefault: false,
              check: null,
              references: null,
            },
          ],
          indexes: [
            { name: 'post_slug_idx', columns: ['slug'], unique: true, where: null, order: null },
          ],
        },
      ],
      current: before,
      name: 'add slug',
      allowDestructive: true,
    });

    const root = await appWith({ [`${migration.id}.sql`]: migrationSql(migration) });
    expect(await checkUngeneratableMigrations(root)).toEqual([]);
  });
});

// The rail only exists if the gate runs it. Reaching into the real step list rather than a stub:
// a check nothing calls is a check that passes forever.
describe('unit · the rail is wired into `x verify`', () => {
  test('the `drift` step reports an undeclared hand-written statement', async () => {
    const root = await appWith({ '0001_init.sql': `-- 0001_init\n${HANDWRITTEN}\n` });
    await Bun.write(join(root, APP_CONFIG_FILE), 'export const config = {};\n');

    const drift = VERIFY_STEPS.find((step) => step.name === 'drift');
    const result = await drift?.run({ root, runner: async () => ({}) as never });
    expect(result?.ok).toBe(false);
    expect(result?.findings.map((finding) => finding.code)).toContain('X_MIGRATION_UNGENERATABLE');
  });
});
