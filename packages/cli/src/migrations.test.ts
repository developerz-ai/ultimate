import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
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

test('a hand-written <id>.down.sql is never read as a migration of its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-migrations-'));
  try {
    await Bun.write(join(dir, 'packages/db/migrations/0001_init.sql'), 'CREATE TABLE a();');
    // The pre-1.2.0 hand-written layout. Read as a migration it would sort first and drop the
    // table the pair exists to reverse.
    await Bun.write(join(dir, 'packages/db/migrations/0001_init.down.sql'), 'DROP TABLE a;');
    const migrations = await readMigrations(dir);
    expect(migrations.map((migration) => migration.id)).toEqual(['0001_init']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SNAPSHOT = {
  tables: [
    {
      schema: 'public',
      name: 'a',
      columns: [{ name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 }],
      primaryKey: ['id'],
      indexes: [
        { name: 'a_pkey', columns: ['id'], unique: true, primary: true, where: null, order: null },
      ],
      foreignKeys: [],
    },
  ],
};

test('the snapshot sidecar rides along, and a corrupt one is absent rather than fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-migrations-'));
  try {
    await Bun.write(join(dir, 'packages/db/migrations/0001_a.sql'), 'CREATE TABLE a();');
    await Bun.write(
      join(dir, 'packages/db/migrations/0001_a.snapshot.json'),
      JSON.stringify(SNAPSHOT),
    );
    await Bun.write(join(dir, 'packages/db/migrations/0002_b.sql'), 'CREATE TABLE b();');
    await Bun.write(join(dir, 'packages/db/migrations/0002_b.snapshot.json'), '{ not json');
    const [first, second] = await readMigrations(dir);
    expect(first?.snapshot).toEqual(SNAPSHOT);
    expect(second?.snapshot).toBeUndefined();
    expect(second?.up).toBe('CREATE TABLE b();');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sidecar that parses as JSON and is not a schema is absent too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-migrations-'));
  try {
    await Bun.write(join(dir, 'packages/db/migrations/0001_a.sql'), 'CREATE TABLE a();');
    // Valid JSON, and a cast called it a `SchemaDescription`: the diff then threw on
    // `table.columns` of `null` instead of regenerating the file it could not read.
    await Bun.write(
      join(dir, 'packages/db/migrations/0001_a.snapshot.json'),
      JSON.stringify({ tables: [null] }),
    );
    expect((await readMigrations(dir))[0]?.snapshot).toBeUndefined();

    // A table missing a required field is the same answer: half a snapshot is not a small one.
    await Bun.write(
      join(dir, 'packages/db/migrations/0001_a.snapshot.json'),
      JSON.stringify({ tables: [{ name: 'a', columns: [], indexes: [], foreignKeys: [] }] }),
    );
    expect((await readMigrations(dir))[0]?.snapshot).toBeUndefined();
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
