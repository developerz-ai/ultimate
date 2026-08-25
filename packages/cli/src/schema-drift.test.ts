// The gate step's own half: entity declarations against the newest migration's sidecar, off disk,
// with no database. Every fixture here is a temp directory holding real `.sql` + `.snapshot.json`
// files, because a sidecar's SHAPE — a field it predates being absent rather than empty — is the
// thing that made this check necessary and a hand-built object would not have it.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntityDescriptionLike, SchemaDescription, TableDescription } from '@ultimat3/db';
import { MIGRATIONS_DIR, snapshotFileName } from './migrations';
import type { Finding } from './output';
import { checkMigrationDrift, checkSnapshotDrift } from './schema-drift';

const DB_PACKAGE = join('packages', 'db');

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'x-schema-drift-'));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** `x db gen`'s two artefacts for one migration, minus the `.hash` this check never reads. */
async function commit(root: string, id: string, snapshot: SchemaDescription): Promise<void> {
  await Bun.write(join(root, DB_PACKAGE, 'src', 'schema.ts'), 'export {};\n');
  await Bun.write(join(root, MIGRATIONS_DIR, `${id}.sql`), 'create table "comments" ();\n');
  await Bun.write(
    join(root, MIGRATIONS_DIR, snapshotFileName(id)),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
}

const COMMENTS_TABLE: TableDescription = {
  schema: 'public',
  name: 'comments',
  columns: [{ name: 'body', dataType: 'text', nullable: false, default: null, position: 1 }],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
};

/**
 * The sidecar `dummy/social-media-clone` was sitting on: written before invariants were projected,
 * so it carries NO `checks` key at all. That absence is the whole fixture.
 */
const SIDECAR_WITHOUT_CHECKS: SchemaDescription = { tables: [COMMENTS_TABLE] };

const comments = (invariants: EntityDescriptionLike['invariants'] = []): EntityDescriptionLike => ({
  name: 'Comment',
  table: 'comments',
  primaryKey: [],
  columns: [
    {
      property: 'body',
      column: 'body',
      kind: 'text',
      notNull: true,
      primaryKey: false,
      unique: false,
      hasDefault: false,
      check: null,
      references: null,
    },
  ],
  indexes: [],
  ...(invariants === undefined ? {} : { invariants }),
});

const BODY_PRESENT = {
  name: 'comment_body_present',
  kind: 'check',
  message: 'a comment needs a body',
  sql: 'length(btrim(body)) > 0',
  where: null,
} as const;

const supply =
  (...entities: readonly EntityDescriptionLike[]) =>
  async (): Promise<readonly EntityDescriptionLike[]> =>
    entities;

const never = async (): Promise<readonly Finding[]> =>
  expect.unreachable('the hash half must not run when the snapshot half found something');

describe('unit · schema snapshot drift', () => {
  // THE test. This is `dummy/social-media-clone` on the day its gate was green while nine declared
  // CHECK constraints had never reached any database: the schema source had not moved, so the
  // `.hash` sidecar matched, and nothing anywhere read the SQL or the snapshot.
  test('a declared check the newest sidecar never recorded is X_DB_SCHEMA_UNMIGRATED', async () => {
    await withRoot(async (root) => {
      await commit(root, '0001_init', SIDECAR_WITHOUT_CHECKS);
      const findings = await checkSnapshotDrift(root, supply(comments([BODY_PRESENT])));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_DB_SCHEMA_UNMIGRATED');
      expect(findings[0]?.cause).toContain('comments_comment_body_present_check');
      expect(findings[0]?.fix).toContain('x db gen');
      expect(findings[0]?.at).toBe(MIGRATIONS_DIR);
    });
  });

  // The false-finding guard the whole design turns on: `checks` is absent, never `[]`, on a table
  // declaring none, so an app whose sidecar predates the field must stay green when it never had a
  // constraint to lose. Without this, every existing app goes red on its first run.
  test('a sidecar with no checks and an entity declaring none is not drift', async () => {
    await withRoot(async (root) => {
      await commit(root, '0001_init', SIDECAR_WITHOUT_CHECKS);
      expect(await checkSnapshotDrift(root, supply(comments()))).toEqual([]);
    });
  });

  // The other direction, and it is the other finding: a constraint the migration carries that no
  // entity declares any more. Its `fix:` may not be a bare `x db gen`, which would emit the DROP.
  test('a recorded check no entity declares is X_DB_SCHEMA_UNDECLARED', async () => {
    await withRoot(async (root) => {
      await commit(root, '0001_init', {
        tables: [
          { ...COMMENTS_TABLE, checks: [{ name: 'comments_gone_check', expression: 'true' }] },
        ],
      });
      const findings = await checkSnapshotDrift(root, supply(comments()));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_DB_SCHEMA_UNDECLARED');
      expect(findings[0]?.cause).toContain('comments_gone_check');
      expect(findings[0]?.fix).toContain('re-declare');
    });
  });

  // A regeneration that would DROP what it cannot write is the danger item 2 names. While the
  // declaration holds an unrendered default, `x db gen` is the wrong instruction and the fix is
  // `@ultimat3/db`'s own — one wording, owned by the package that knows what went missing.
  test('an unrendered declaration replaces the x db gen fix with the edit that restores it', async () => {
    await withRoot(async (root) => {
      await commit(root, '0001_init', SIDECAR_WITHOUT_CHECKS);
      const entity = comments([BODY_PRESENT]);
      const unrenderable: EntityDescriptionLike = {
        ...entity,
        columns: entity.columns.map((column) => ({ ...column, hasDefault: true })),
      };
      const findings = await checkSnapshotDrift(root, supply(unrenderable));
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) expect(finding.fix).not.toContain('x db gen "');
      expect(findings[0]?.fix).toContain('packages/entity/src/describe.ts');
    });
  });

  test('an app with no packages/db is not judged at all', async () => {
    await withRoot(async (root) => {
      expect(await checkSnapshotDrift(root, supply(comments([BODY_PRESENT])))).toEqual([]);
    });
  });

  // An app whose modules will not import leaves the registry SHORT, and a short registry reads as
  // "every table was dropped" — one unloadable file would report the whole schema as undeclared
  // and hand the reader a DROP for each of it.
  test('an app that will not load reports nothing here', async () => {
    await withRoot(async (root) => {
      await commit(root, '0001_init', SIDECAR_WITHOUT_CHECKS);
      expect(await checkSnapshotDrift(root, async () => undefined)).toEqual([]);
    });
  });

  // The first migration is `checkSourceDrift`'s condition, with its own cause and its own
  // `x db gen "initial"`. Reported here too it would be one condition with two reporters.
  test('an app with no migration at all is left to the source-hash half', async () => {
    await withRoot(async (root) => {
      await Bun.write(join(root, DB_PACKAGE, 'src', 'schema.ts'), 'export {};\n');
      expect(await checkSnapshotDrift(root, supply(comments([BODY_PRESENT])))).toEqual([]);
    });
  });

  // A newest migration with no sidecar is `X_MIGRATION_SNAPSHOT_MISSING` — `x db gen`'s refusal,
  // with its own two-branch remedy. A second reporter here would be a second wording for it.
  test('a newest migration with no sidecar is left to x db gen', async () => {
    await withRoot(async (root) => {
      await Bun.write(join(root, DB_PACKAGE, 'src', 'schema.ts'), 'export {};\n');
      await Bun.write(join(root, MIGRATIONS_DIR, '0001_init.sql'), 'select 1;\n');
      expect(await checkSnapshotDrift(root, supply(comments([BODY_PRESENT])))).toEqual([]);
    });
  });
});

describe('unit · the two no-database detectors compose', () => {
  // Both detectors answer "a declaration no migration carries", and the specific one is the
  // instruction: `schema hashes to 3f2a` teaches nobody which constraint went missing.
  test('the hash half does not run when the snapshot half found something', async () => {
    await withRoot(async (root) => {
      await commit(root, '0001_init', SIDECAR_WITHOUT_CHECKS);
      const findings = await checkMigrationDrift(root, supply(comments([BODY_PRESENT])), never);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_DB_SCHEMA_UNMIGRATED');
    });
  });

  // And it stays, because it catches a class the snapshot comparison cannot: a seed, a helper or a
  // TS-only invariant moving under `packages/db/src` with no physical schema change behind it.
  test('the hash half still answers when the snapshots agree', async () => {
    await withRoot(async (root) => {
      await commit(root, '0001_init', SIDECAR_WITHOUT_CHECKS);
      const hash = async (): Promise<readonly Finding[]> => [
        { code: 'X_DB_DRIFT', cause: 'a seed moved', fix: 'x db gen "describe the change"' },
      ];
      const findings = await checkMigrationDrift(root, supply(comments()), hash);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_DB_DRIFT');
    });
  });
});
