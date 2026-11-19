// The pass hands `rollback()` the database it runs against, so the consent rule for a database on
// another machine is asked of the real binding: `DATABASE_URL=<remote>` with no environment named
// is refused until `ROLLBACK_ALLOW_DESTRUCTIVE` names the id.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: `node:fs` — Bun has no temp-directory API.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { migrate, pgliteClient, ROLLBACK_ALLOW_DESTRUCTIVE_ENV, setDbClient } from '@ultimat3/db';
import { reverseApplied } from './db-rollback-pass';
import { MIGRATIONS_DIR, readMigrations } from './migrations';

const PGLITE_BOOT_MS = 30_000;
const ID = '0001_gizmos';
const REMOTE = 'postgres://app@db.prod.example.com:5432/app';
const root = mkdtempSync(join(tmpdir(), 'x-rollback-pass-'));
const client = pgliteClient();

beforeAll(async () => {
  await Bun.write(
    join(root, MIGRATIONS_DIR, `${ID}.sql`),
    'create table gizmos (id uuid primary key);\n-- down\ndrop table gizmos;\n',
  );
  await migrate({ migrations: await readMigrations(root), client });
  setDbClient(client);
}, PGLITE_BOOT_MS);

afterAll(() => {
  setDbClient(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('reverseApplied', () => {
  test('a remote DATABASE_URL needs the names even when no environment is set', async () => {
    const refused = await reverseApplied(root, { DATABASE_URL: REMOTE }, 1).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUltimateError(refused) ? refused.code : refused).toBe(
      'X_MIGRATION_ROLLBACK_DESTRUCTIVE',
    );

    const named = { DATABASE_URL: REMOTE, [ROLLBACK_ALLOW_DESTRUCTIVE_ENV]: ID };
    expect(await reverseApplied(root, named, 1)).toEqual([ID]);
  });
});
