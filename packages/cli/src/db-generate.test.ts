// `x db gen` on the framework's own engine: what it writes, what it refuses to write, and the
// round trip that makes the second generation incremental — the file it emits must parse back
// through the reader that applies it, and its snapshot must be the schema the next diff starts from.

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declaredSchema, generateMigration } from '@ultimat3/db';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import { generateAppMigration, migrationSql } from './db-generate';
import { readMigrations } from './migrations';

// Registered here rather than inside a test: `entity()` writes to a process-wide registry that
// `describeEntities()` reads whole, so the fixture is declared once and cleared once.
entity('db_gen_test_notes', {
  columns: {
    id: uuid().primaryKey(),
    body: text({ max: 200 }),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(() => {
  clearRegistry();
});

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'x-db-gen-'));

test('the generated file parses back through the reader that applies it', async () => {
  const migration = generateMigration({
    entities: [
      {
        name: 'Note',
        table: 'notes',
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
    ],
    name: 'add notes',
    now: new Date('2026-08-14T09:30:00Z'),
  });
  const dir = tempRoot();
  try {
    await Bun.write(
      join(dir, 'packages/db/migrations', `${migration.id}.sql`),
      migrationSql(migration),
    );
    const [read] = await readMigrations(dir);
    expect(read?.id).toBe(migration.id);
    // The header is a SQL comment and rides along in `up`; the statements below it are the ones
    // that must survive the trip, and `down` must survive it whole.
    expect(read?.up).toContain(migration.up);
    expect(read?.down).toBe(migration.down);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a message with a newline cannot break out of the header comment', () => {
  const migration = generateMigration({
    entities: [],
    name: 'oops\nDROP TABLE users;',
    now: new Date('2026-08-14T09:30:00Z'),
  });
  expect(migrationSql(migration)).not.toContain('DROP TABLE users;');
});

test('generation writes the sql, the snapshot and the hash, and the snapshot is the next diff', async () => {
  const dir = tempRoot();
  try {
    // `schemaHash` globs `packages/db/src/**/*.ts`; a schema file makes the sidecar meaningful.
    await Bun.write(join(dir, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');
    const generated = await generateAppMigration(dir, { name: 'add notes' });
    const id = generated.migration?.id;
    expect(id).toBeDefined();
    expect(generated.files).toEqual([
      `packages/db/migrations/${id}.sql`,
      `packages/db/migrations/${id}.snapshot.json`,
      `packages/db/migrations/${id}.hash`,
    ]);
    expect(generated.schemaHash).toMatch(/^[0-9a-f]{16}$/);

    const migrations = await readMigrations(dir);
    expect(migrations).toHaveLength(1);
    expect(declaredSchema(migrations).tables.map((table) => table.name)).toEqual([
      'db_gen_test_notes',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second run against an unchanged schema writes nothing at all', async () => {
  const dir = tempRoot();
  try {
    await generateAppMigration(dir, { name: 'add notes' });
    const again = await generateAppMigration(dir, { name: 'add notes again' });
    expect(again.migration).toBeUndefined();
    expect(again.files).toEqual([]);
    expect((await readMigrations(dir)).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an app whose modules will not load generates nothing — a short registry drops tables', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, 'packages/db/src/broken.ts'), 'throw new Error("boom");\n');
    const generated = await generateAppMigration(dir, { name: 'add notes' });
    expect(generated.migration).toBeUndefined();
    expect(generated.files).toEqual([]);
    expect(generated.findings.length).toBeGreaterThan(0);
    expect(await readMigrations(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
