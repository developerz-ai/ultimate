// `x db gen` on the framework's own engine: what it writes, what it refuses to write, and the
// round trip that makes the second generation incremental — the file it emits must parse back
// through the reader that applies it, and its snapshot must be the schema the next diff starts from.

import { afterAll, expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declaredSchema, generateMigration, snapshotJson } from '@ultimat3/db';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import { generateAppMigration, migrationSql } from './db-generate';
import { checkSourceDrift, schemaHash } from './drift';
import { MIGRATIONS_DIR, readMigrations } from './migrations';

// Registered here rather than inside a test: `entity()` writes to a process-wide registry that
// `describeEntities()` reads whole, so the fixture is declared once and cleared once.
const registerFixtureEntity = (): void => {
  entity('db_gen_test_notes', {
    columns: {
      id: uuid().primaryKey(),
      body: text({ max: 200 }),
      createdAt: timestamp().defaultNow(),
    },
  });
};
registerFixtureEntity();

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
    // `declaredSchema` answers `undefined` when the newest migration carries no snapshot; `x db
    // gen` always writes one, so an absent schema is itself the failure — and `?.` reports it as a
    // mismatch against the expected list rather than crashing the test.
    expect(declaredSchema(migrations)?.tables.map((table) => table.name)).toEqual([
      'db_gen_test_notes',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A scaffolded app's `lint` step is `biome check .`, and `.sql`/`.hash` are types Biome does not
// process — so the sidecar is the first migration artefact the app's own gate ever reads. The bytes
// are `@ultimat3/db`'s `snapshotJson`, which is a fixed point of the formatter;
// `JSON.stringify(…, null, 2)` is not, so the generator used to write a file its own gate rejected.
test('the snapshot sidecar is written as the bytes biome would have printed', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');
    const generated = await generateAppMigration(dir, { name: 'add notes' });
    const snapshot = generated.migration?.snapshot;
    expect(snapshot).toBeDefined();
    const written = await Bun.file(
      join(dir, MIGRATIONS_DIR, `${generated.migration?.id}.snapshot.json`),
    ).text();

    // Asserted to DIFFER from the naive spelling first, so this fixture cannot pass by the two
    // serialisers happening to agree — `primaryKey: ["id"]` is what Biome collapses and
    // `JSON.stringify` never does.
    const naive = `${JSON.stringify(snapshot, null, 2)}\n`;
    expect(written).not.toBe(naive);
    expect(written).toBe(snapshotJson(snapshot ?? { tables: [] }));
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
    expect(again.outcome).toBe('unchanged');
    expect(again.files).toEqual([]);
    expect((await readMigrations(dir)).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The whole point of the slice. `X_DB_DRIFT`'s `fix:` is `x db gen "describe the change"`, and the
// hash it compares covers every non-test file under `packages/db/src` — a seed, a helper, a
// decorator — not only the ones that imply DDL. So an ordinary edit moves the hash with no diff
// behind it, and until the empty-diff path recorded the sidecar the instruction ran clean, changed
// nothing and left the gate red forever, with hand-editing a generated file as the only way out.
test('an empty diff re-records the schema hash, so following the drift fix actually clears it', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');
    const first = await generateAppMigration(dir, { name: 'add notes' });
    const id = first.migration?.id;
    expect(await checkSourceDrift(dir)).toEqual([]);

    await Bun.write(join(dir, 'packages/db/src/seed.ts'), 'export const seed = () => {};\n');
    expect(await checkSourceDrift(dir)).toHaveLength(1);

    const again = await generateAppMigration(dir, { name: 'describe the change' });
    expect(again.migration).toBeUndefined();
    expect(again.outcome).toBe('hash-recorded');
    expect(again.schemaHash).toBe(await schemaHash(dir));
    expect(again.files).toEqual([`packages/db/migrations/${id}.hash`]);
    // No second migration, no second snapshot — the sidecar is the only thing that moved.
    expect((await readMigrations(dir)).length).toBe(1);
    expect(await checkSourceDrift(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The check must not be blunted by its own remedy: a real DDL change still has to be a migration,
// never a sidecar rewrite that makes the gate green over a schema no migration builds.
test('a real DDL change still generates a migration — the empty-diff path is never reached', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');
    // No migrations yet, so the registered entity IS a diff: the first run must be a real one.
    const first = await generateAppMigration(dir, { name: 'add notes' });
    expect(first.outcome).toBe('generated');
    const id = first.migration?.id;
    expect(first.files).toEqual([
      `packages/db/migrations/${id}.sql`,
      `packages/db/migrations/${id}.snapshot.json`,
      `packages/db/migrations/${id}.hash`,
    ]);
    expect(first.migration?.up ?? '').toContain('db_gen_test_notes');
    expect(declaredSchema(await readMigrations(dir))?.tables.map((table) => table.name)).toEqual([
      'db_gen_test_notes',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `checkSourceDrift`'s first branch: an app with a schema, an entity and NO migration. There is no
// migration id to attach a sidecar to, so the empty-diff path must write nothing — and it cannot
// be reached with an entity declared, because an entity against zero migrations is a real diff.
test('an empty diff with no migration at all records nothing — there is no id to record against', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');
    clearRegistry();
    const generated = await generateAppMigration(dir, { name: 'initial' });
    expect(generated.outcome).toBe('unchanged');
    expect(generated.files).toEqual([]);
    expect(await readMigrations(dir)).toEqual([]);
    // And the gate agrees: zero declared against zero recorded is agreement, not drift.
    expect(await checkSourceDrift(dir, async () => 0)).toEqual([]);
  } finally {
    registerFixtureEntity();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an app whose modules will not load is blocked, and blocked is not unchanged', async () => {
  const dir = tempRoot();
  try {
    await Bun.write(join(dir, 'packages/db/src/broken.ts'), 'throw new Error("boom");\n');
    const generated = await generateAppMigration(dir, { name: 'add notes' });
    expect(generated.outcome).toBe('blocked');
    expect(generated.schemaHash).toBeUndefined();
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

test('a newest migration with no snapshot refuses to generate, never diffs against nothing', async () => {
  const dir = tempRoot();
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  // Diffed against the empty schema instead, every table the database already holds looks new and
  // the generated `up` is `create table` for all of them.
  await Bun.write(join(dir, MIGRATIONS_DIR, '0001_init.sql'), 'create table "gen_posts" ();');

  const failure: unknown = await generateAppMigration(dir, { name: 'anything' }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeUltimateError('X_MIGRATION_SNAPSHOT_MISSING');
  expect((failure as { fix: string }).fix).toContain('0001_init.snapshot.json');
  rmSync(dir, { recursive: true, force: true });
});
