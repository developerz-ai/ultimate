// Source drift is a gate step (`x verify`'s `drift`) and a `x doctor` finding, so what it does and
// does not call drift is a contract. It reads files and never a database — every test here runs
// against a temp directory with nothing listening, which is the whole point of the check.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSourceDrift, DB_PACKAGE, recordedHashes, schemaHash, writeSchemaHash } from './drift';
import { MIGRATIONS_DIR } from './migrations';

const appRoot = (): string => mkdtempSync(join(tmpdir(), 'x-drift-'));

const writeSchema = (root: string, body: string): Promise<number> =>
  Bun.write(join(root, DB_PACKAGE, 'src', 'schema.ts'), body);

/** `x db gen` writes the migration and its `.hash` sidecar together; this is that pair. */
async function generate(root: string, id: string): Promise<string> {
  await Bun.write(join(root, MIGRATIONS_DIR, `${id}.sql`), 'select 1;\n');
  return writeSchemaHash(root, id);
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = appRoot();
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('unit · source drift', () => {
  test('an app with no db package is not drifted — it may simply have no database yet', async () => {
    await withRoot(async (root) => {
      expect(await checkSourceDrift(root)).toEqual([]);
    });
  });

  test('a schema no migration ever recorded is drift, and the fix generates the first one', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      const findings = await checkSourceDrift(root, async () => 1);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_DB_DRIFT');
      expect(findings[0]?.cause).toBe('packages/db has a schema but no migration recorded it');
      expect(findings[0]?.fix).toBe('x db gen "initial"');
      expect(findings[0]?.at).toBe(MIGRATIONS_DIR);
    });
  });

  // The regression `x new --no-example` shipped: no entity declared, so `x db gen "initial"` has an
  // empty diff, writes no `.hash`, and exits ok — leaving this finding standing behind a fix that
  // runs clean and changes nothing. Zero declared against zero recorded is agreement, not drift.
  test('a db package declaring no entity is not drift — the fix would generate nothing', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export {};\n');
      expect(await checkSourceDrift(root, async () => 0)).toEqual([]);
    });
  });

  // The limit of the source model, pinned so it is a decision and not a surprise: with the entities
  // gone AND the migrations deleted there is nothing recorded to disagree with, so this answers
  // clean. A database still holding those tables is the OTHER drift — `checkDrift` in
  // `@ultimat3/db`, which `runMigrations` asks where a connection is open.
  test('entities and migrations both gone is agreement here; the database half is elsewhere', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export {};\n');
      expect(await checkSourceDrift(root, async () => 0)).toEqual([]);
    });
  });

  // Entities removed while the migrations stay is NOT the branch above: a recorded hash exists, so
  // the comparison below answers, and its fix is a real diff — `generateMigration` refuses that one
  // with X_MIGRATION_IRREVERSIBLE and its own `--allow-destructive` fix. A chain of instructions,
  // never a no-op.
  test('entities removed with migrations still committed stays drift, on the hash comparison', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      await generate(root, '0001_initial');
      await writeSchema(root, 'export {};\n');
      const findings = await checkSourceDrift(root, async () => 0);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.fix).toBe('x db gen "describe the change"');
    });
  });

  test('the hash the last generate recorded is what makes a schema clean', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      const recorded = await generate(root, '0001_initial');
      expect(recorded).toBe(await schemaHash(root));
      expect(await checkSourceDrift(root)).toEqual([]);
    });
  });

  test('an edited entity with no migration names both hashes and says what to run', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      const recorded = await generate(root, '0001_initial');
      await writeSchema(root, 'export const posts = 1;\nexport const comments = 2;\n');

      const findings = await checkSourceDrift(root);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.cause).toBe(
        `schema hashes to ${await schemaHash(root)}, newest migration 0001_initial.hash recorded ${recorded}`,
      );
      expect(findings[0]?.fix).toBe('x db gen "describe the change"');
      expect(findings[0]?.at).toBe(`${DB_PACKAGE}/src`);
    });
  });

  test('a change reverted to any recorded hash is clean, not drift against the newest', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      const first = await generate(root, '0001_initial');
      await writeSchema(root, 'export const posts = 2;\n');
      await generate(root, '0002_change');

      // Back to what 0001 recorded: the schema is a state some migration produced, so there is
      // nothing to generate. Comparing against the newest alone would demand an empty migration.
      await writeSchema(root, 'export const posts = 1;\n');
      expect(await schemaHash(root)).toBe(first);
      expect(await checkSourceDrift(root)).toEqual([]);
    });
  });

  test('a test file is not schema — editing one never asks for a migration', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      await generate(root, '0001_initial');
      await Bun.write(join(root, DB_PACKAGE, 'src', 'schema.test.ts'), 'test("x", () => {});\n');
      expect(await checkSourceDrift(root)).toEqual([]);
    });
  });

  test('the hash covers the path as well as the body, so a rename is a change', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      const before = await schemaHash(root);
      rmSync(join(root, DB_PACKAGE, 'src', 'schema.ts'));
      await Bun.write(join(root, DB_PACKAGE, 'src', 'tables.ts'), 'export const posts = 1;\n');
      expect(await schemaHash(root)).not.toBe(before);
    });
  });

  test('recorded hashes sort oldest-first, so `.at(-1)` is the newest migration', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      await generate(root, '0002_change');
      await generate(root, '0001_initial');
      expect((await recordedHashes(root)).map((record) => record.file)).toEqual([
        '0001_initial.hash',
        '0002_change.hash',
      ]);
    });
  });
});
