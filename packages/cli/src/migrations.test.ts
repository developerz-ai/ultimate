import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationName, parseMigrationSql, readMigrations } from './migrations';

test('a migration splits into up and down at the -- down line', () => {
  const parsed = parseMigrationSql(
    '0000_initial',
    'CREATE TABLE posts (id uuid);\n\n-- down\nDROP TABLE posts;\n',
  );
  expect(parsed.up).toBe('CREATE TABLE posts (id uuid);');
  expect(parsed.down).toBe('DROP TABLE posts;');
  expect(parsed.name).toBe('initial');
});

test('a comment that merely says "down" is not the marker', () => {
  const parsed = parseMigrationSql('0001_x', '-- down migrations are required\nCREATE TABLE a();');
  expect(parsed.down).toBe('');
  expect(parsed.up).toContain('CREATE TABLE a()');
});

test('a file with no down section still parses, with an empty reverse', () => {
  expect(parseMigrationSql('0002_y', 'CREATE TABLE b();').down).toBe('');
});

test('the ledger name drops the numeric prefix and nothing else', () => {
  expect(migrationName('20260726120000_add_publish_at')).toBe('add_publish_at');
  expect(migrationName('no_prefix')).toBe('no_prefix');
});

test('an app with no migrations directory reads an empty list, never a throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-migrations-'));
  try {
    expect(await readMigrations(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations are read in id order, whatever order the directory yields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-migrations-'));
  try {
    await Bun.write(join(dir, 'packages/db/migrations/0002_b.sql'), 'CREATE TABLE b();');
    await Bun.write(join(dir, 'packages/db/migrations/0000_a.sql'), 'CREATE TABLE a();');
    await Bun.write(join(dir, 'packages/db/migrations/0001_c.sql'), 'CREATE TABLE c();');
    // A `.hash` sidecar sits beside every migration; picking it up would apply a hash as SQL.
    await Bun.write(join(dir, 'packages/db/migrations/0000_a.hash'), 'deadbeef');
    expect((await readMigrations(dir)).map((migration) => migration.id)).toEqual([
      '0000_a',
      '0001_c',
      '0002_b',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
