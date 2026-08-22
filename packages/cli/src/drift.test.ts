// Source drift is a gate step (`x verify`'s `drift`) and a `x doctor` finding, so what it does and
// does not call drift is a contract. It reads files and never a database — every test here runs
// against a temp directory with nothing listening, which is the whole point of the check.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSourceDrift,
  DB_PACKAGE,
  reconcileSchemaHash,
  recordedHashes,
  schemaHash,
  writeSchemaHash,
} from './drift';
import { MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';

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

  // The remedy half of the same contract. `X_DB_DRIFT`'s `fix:` is `x db gen "describe the
  // change"`, and the generator can only follow it by re-recording the sidecar — so the predicate
  // that decides "already recorded" is one function, shared with `checkSourceDrift`, or the fix
  // reports written while the check still reports drift.
  test('reconciling records the current hash against the named migration and clears the drift', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      await generate(root, '0001_initial');
      // A non-DDL file under `packages/db/src` — a seed, a helper — moves the hash and no DDL.
      await Bun.write(join(root, DB_PACKAGE, 'src', 'seed.ts'), 'export const seed = 1;\n');
      expect(await checkSourceDrift(root)).toHaveLength(1);

      const reconciled = await reconcileSchemaHash(root, '0001_initial');
      expect(reconciled).toEqual({ hash: await schemaHash(root), written: true });
      expect(await checkSourceDrift(root)).toEqual([]);
    });
  });

  test('reconciling a hash some migration already recorded writes nothing and says so', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      const recorded = await generate(root, '0001_initial');
      const reconciled = await reconcileSchemaHash(root, '0001_initial');
      expect(reconciled).toEqual({ hash: recorded, written: false });
    });
  });

  // The same rule `checkSourceDrift` answers clean on: a schema reverted to a state some OLDER
  // migration recorded is not drift, so reconciling it must not stamp the newest migration with a
  // hash it did not produce — the sidecar would then claim `0002` left behind `0001`'s schema.
  test('reconciling an older recorded hash writes nothing — the sidecar is not restamped', async () => {
    await withRoot(async (root) => {
      await writeSchema(root, 'export const posts = 1;\n');
      const first = await generate(root, '0001_initial');
      await writeSchema(root, 'export const posts = 2;\n');
      const second = await generate(root, '0002_change');
      await writeSchema(root, 'export const posts = 1;\n');

      expect(await reconcileSchemaHash(root, '0002_change')).toEqual({
        hash: first,
        written: false,
      });
      const records = await recordedHashes(root);
      expect(records.map((record) => record.hash)).toEqual([first, second]);
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

// The half `SCHEMA_GLOB` cannot see, and the reason it needs its own describe block: `x new` puts
// an entity at `apps/web/app/<feature>/entity.ts` and `packages/db/src/schema.ts` only re-exports
// it, so every byte the glob reads is identical before and after a column is added. Measured on the
// unfixed check: three generated entities, one migration, `drift` green, every `.hash` identical.
//
// Every case runs in a SUBPROCESS, for the two reasons `app-entities.test.ts` gives and one more:
// `import()` caches, so a module edited inside one process registers its FIRST version forever —
// an in-process edit-then-rehash cannot tell a fixed check from a broken one.
describe('unit · entities outside packages/db are schema', () => {
  const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
  const DRIFT_MODULE = join(import.meta.dir, 'drift.ts');
  /** Absolute, because the temp app has no `node_modules`: a bare specifier registers nothing. */
  const ENTITY_MODULE = join(import.meta.dir, '..', '..', 'entity', 'src', 'index.ts');

  /** One `x` invocation: one process, one app load, one registry. */
  async function inFreshProcess(root: string, expression: string): Promise<string> {
    const script =
      `const drift = await import(${JSON.stringify(DRIFT_MODULE)});\n` +
      `await Bun.stdout.write(String(await (${expression})(${JSON.stringify(root)})));\n`;
    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect({ code, stderr: await new Response(proc.stderr).text() }).toMatchObject({ code: 0 });
    return out.trim();
  }

  const writeEntity = (root: string, columns: string): Promise<number> =>
    Bun.write(
      join(root, 'apps', 'web', 'app', 'post', 'entity.ts'),
      `import { entity, text, uuid } from ${JSON.stringify(ENTITY_MODULE)};\n` +
        `export const post = entity('drift_test_posts', { columns: { ${columns} } });\n`,
    );

  /** The scaffold's own layout: the entity lives under `apps/`, `packages/db` re-exports it. */
  async function scaffold(root: string, columns: string): Promise<void> {
    await writeEntity(root, columns);
    await writeSchema(root, "export { post } from '../../../apps/web/app/post/entity';\n");
    await Bun.write(join(root, MIGRATIONS_DIR, '0001_init.sql'), 'select 1;\n');
  }

  const ONE_COLUMN = 'id: uuid().primaryKey()';
  const TWO_COLUMNS = 'id: uuid().primaryKey(), body: text({ max: 4000 })';

  test('a column added to an entity under apps/ is drift, though no db/src byte moved', async () => {
    await withRoot(async (root) => {
      await scaffold(root, ONE_COLUMN);
      const recorded = await inFreshProcess(root, 'drift.writeSchemaHash');
      // Read back through the same helper the check uses, so this is the recorded value and not a
      // second spelling of it. `writeSchemaHash` returns the hash it wrote.
      expect(recorded).toMatch(/^[0-9a-f]{16}$/);

      await writeEntity(root, TWO_COLUMNS);
      const findings = JSON.parse(
        await inFreshProcess(root, 'async (r) => JSON.stringify(await drift.checkSourceDrift(r))'),
      ) as readonly Finding[];
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_DB_DRIFT');
      expect(findings[0]?.fix).toBe('x db gen "describe the change"');
      expect(findings[0]?.cause).toContain(`recorded ${recorded}`);
    });
  });

  // The direct statement of the mutation the case above catches: with the registry dropped from
  // `schemaHash`, these two hashes are equal — `1a8ab3d182f3122d` in both processes, measured.
  test('two entity shapes over identical packages/db bytes hash differently', async () => {
    await withRoot(async (root) => {
      await scaffold(root, ONE_COLUMN);
      const before = await inFreshProcess(root, 'drift.schemaHash');
      const dbBytes = await Bun.file(join(root, DB_PACKAGE, 'src', 'schema.ts')).text();

      await writeEntity(root, TWO_COLUMNS);
      const after = await inFreshProcess(root, 'drift.schemaHash');
      // The premise: the glob's own input is byte-identical, so anything that differs is the
      // registry. Asserted, not assumed — a fixture that quietly edited it would prove nothing.
      expect(await Bun.file(join(root, DB_PACKAGE, 'src', 'schema.ts')).text()).toBe(dbBytes);
      expect(after).not.toBe(before);
    });
  });

  // The other direction, and the one that keeps `x verify` usable: a hash is a build input, so two
  // machines and two runs must agree. Re-running the same app must not move it.
  test('the same app hashes the same in two processes — the hash is a committed fact', async () => {
    await withRoot(async (root) => {
      await scaffold(root, TWO_COLUMNS);
      expect(await inFreshProcess(root, 'drift.schemaHash')).toBe(
        await inFreshProcess(root, 'drift.schemaHash'),
      );
    });
  });
});
