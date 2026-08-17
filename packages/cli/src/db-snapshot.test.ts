// `x db gen`'s refusal, asked as a diagnostic instead of hit as a throw: the newest migration with
// no snapshot sidecar is an app whose next generation cannot start, and `x doctor` is the command
// every `X_CLI_UNEXPECTED` names.

import { expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationSnapshots } from './db-snapshot';
import { MIGRATIONS_DIR } from './migrations';

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'x-db-snapshot-'));

test('an app with no migrations at all reports nothing — that is the scaffold, not a fault', async () => {
  const dir = tempRoot();
  try {
    expect(await checkMigrationSnapshots(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the newest migration with no sidecar is X_MIGRATION_SNAPSHOT_MISSING, naming the file', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, MIGRATIONS_DIR, '0001_init.sql'), 'create table "posts" ();');
    const [finding, ...rest] = await checkMigrationSnapshots(dir);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_MIGRATION_SNAPSHOT_MISSING');
    expect(finding?.at).toBe(`${MIGRATIONS_DIR}/0001_init.snapshot.json`);
    // The two remedies `@ultimat3/db` words, in its order — restore, or delete the files first and
    // only then generate. A `fix:` naming `x db gen` before the removal is the cycle this closes.
    expect(finding?.fix).toContain('git checkout --');
    expect(finding?.fix).toContain('x db gen "init"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sidecar beside the newest migration clears it, even when older ones have none', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, MIGRATIONS_DIR, '0001_init.sql'), 'create table "posts" ();');
    await Bun.write(join(dir, MIGRATIONS_DIR, '0002_more.sql'), 'create table "tags" ();');
    // Only the NEWEST is what the next diff starts from — reaching back to an older snapshot would
    // report a column the database correctly holds as drift.
    await Bun.write(join(dir, MIGRATIONS_DIR, '0002_more.snapshot.json'), '{ "tables": [] }\n');
    expect(await checkMigrationSnapshots(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
