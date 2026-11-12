// The lock-heavy rail as `x verify` runs it: over real migration files on disk, through the reader
// `x db migrate` applies from, judged only past the framework's bound, and wired into the drift
// step beside the destructive rail.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API, and a fixture tree must exist before
// the gate reads it, so these are the synchronous Node ones.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { LOCK_HEAVY_MARKER } from '@ultimat3/db';
import { checkLockHeavyMigrations } from './migration-lock-check';
import { MIGRATIONS_DIR } from './migrations';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An app root holding exactly the migration files named. */
async function appWith(files: Readonly<Record<string, string>>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-lock-heavy-'));
  roots.push(root);
  mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    await Bun.write(join(root, MIGRATIONS_DIR, name), sql);
  }
  return root;
}

const NEW = '20261201000000_index_status';
const BUILD = 'create index "runs_status_idx" on "runs" ("status");\n';

describe('unit · the lock-heavy rail', () => {
  test('a plain build in a new migration is X_MIGRATION_LOCK_HEAVY, naming the file', async () => {
    const root = await appWith({ [`${NEW}.sql`]: `-- ${NEW}\n${BUILD}` });
    const [finding, ...rest] = await checkLockHeavyMigrations(root);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_MIGRATION_LOCK_HEAVY');
    expect(finding?.at).toBe(`${MIGRATIONS_DIR}/${NEW}.sql`);
    expect(finding?.cause).toContain('create index "runs_status_idx" on "runs" ("status")');
    expect(finding?.fix).toContain(LOCK_HEAVY_MARKER);
    expect(finding?.docs).toBe(ERROR_DOCS_URL);
  });

  test('the marker clears the statement directly under it', async () => {
    const root = await appWith({ [`${NEW}.sql`]: `${LOCK_HEAVY_MARKER}\n${BUILD}` });
    expect(await checkLockHeavyMigrations(root)).toEqual([]);
  });

  test('a marked build never clears an unmarked set not null beside it', async () => {
    const root = await appWith({
      [`${NEW}.sql`]: `${LOCK_HEAVY_MARKER}\n${BUILD}alter table "runs" alter column "status" set not null;\n`,
    });
    const [finding, ...rest] = await checkLockHeavyMigrations(root);
    expect(rest).toEqual([]);
    expect(finding?.cause).toContain('alter table "runs" alter column "status" set not null');
    expect(finding?.cause).not.toContain('more');
  });

  test('a migration from before the rail is never judged: it cannot gain a marker', async () => {
    const root = await appWith({ '20261101000000_index_status.sql': BUILD });
    expect(await checkLockHeavyMigrations(root)).toEqual([]);
  });

  test('the drift step runs it beside the destructive rail', async () => {
    const source = await Bun.file(new URL('./verify-checks.ts', import.meta.url)).text();
    expect(source).toContain('...(await checkLockHeavyMigrations(ctx.root)),');
  });
});
