// The rolling-deploy rail as `x verify` runs it: over real files through the reader `x db migrate`
// applies from, bounded by `rollingSince`. An existing app with the key unset stays green here.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API, and a fixture tree must exist before
// the gate reads it, so these are the synchronous Node ones. `node:path` — no Bun path joiner.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import { generateMigration, ROLLING_UNSAFE_MARKER, snapshotOf } from '@ultimat3/db';
import { VERIFY_STEPS } from './cmd-verify';
import { migrationSql } from './db-generate';
import { checkRollingMigrations } from './db-rolling';
import { MIGRATIONS_DIR } from './migrations';
import { VERIFY_FLOOR_FILE } from './verify-floor';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function appWith(
  files: Readonly<Record<string, string>>,
  rollingSince?: unknown,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-rolling-'));
  roots.push(root);
  mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    await Bun.write(join(root, MIGRATIONS_DIR, name), sql);
  }
  await Bun.write(
    join(root, VERIFY_FLOOR_FILE),
    JSON.stringify({ steps: [], ...(rollingSince === undefined ? {} : { rollingSince }) }),
  );
  return root;
}

const DROP = 'alter table "post" drop column "body";\n';

describe('x verify · the rolling rail', () => {
  test('unset: the rail does not run, whatever the files hold', async () => {
    expect(await checkRollingMigrations(await appWith({ '0002_drop.sql': DROP }))).toEqual([]);
  });

  test('no floor at all reports nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-rolling-'));
    roots.push(root);
    expect(await checkRollingMigrations(root)).toEqual([]);
  });

  test('"0" judges everything, and a finding names the file and the path', async () => {
    const [finding, ...rest] = await checkRollingMigrations(
      await appWith({ '0002_drop.sql': DROP }, '0'),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_MIGRATION_ROLLING_UNSAFE');
    expect(finding?.at).toBe(`${MIGRATIONS_DIR}/0002_drop.sql`);
    expect(finding?.cause).toContain('drop column "body"');
    expect(finding?.fix).toContain(`entity('post', { retired: ['body'] })`);
  });

  test('the bound: at or before rollingSince was applied and cannot gain a marker', async () => {
    const files = { '0002_drop.sql': DROP, '0003_drop.sql': 'alter table "t" drop column "c";\n' };
    expect(await checkRollingMigrations(await appWith(files, '0003_drop'))).toEqual([]);
    const later = await checkRollingMigrations(await appWith(files, '0002_drop'));
    expect(later.map((each) => each.at)).toEqual([`${MIGRATIONS_DIR}/0003_drop.sql`]);
  });

  test('a retire before the bound still earns the drop after it', async () => {
    const root = await appWith(
      {
        '0001_retire.sql': '-- retires "post"."body"\n',
        '0002_drop.sql': `-- contracts "post"."body"\n${DROP}`,
      },
      '0001_retire',
    );
    expect(await checkRollingMigrations(root)).toEqual([]);
  });

  test('a retire taken back earns no later drop', async () => {
    const root = await appWith(
      {
        '0001_retire.sql': '-- retires "post"."body"\n',
        '0002_back.sql': '-- unretires "post"."body"\n',
        '0003_drop.sql': DROP,
      },
      '0',
    );
    expect((await checkRollingMigrations(root)).length).toBe(1);
  });

  test('a retire in the same file is one deploy, so not earlier', async () => {
    const root = await appWith({ '0002_both.sql': `-- retires "post"."body"\n${DROP}` }, '0');
    expect((await checkRollingMigrations(root)).length).toBe(1);
  });

  test('the marker declares the whole file; a mention declares nothing', async () => {
    const declared = await appWith({ '0002.sql': `${ROLLING_UNSAFE_MARKER}\n${DROP}` }, '0');
    expect(await checkRollingMigrations(declared)).toEqual([]);
    const mention = await appWith(
      { '0002.sql': `-- rolling-unsafe: true is the marker\n${DROP}` },
      '0',
    );
    expect((await checkRollingMigrations(mention)).length).toBe(1);
  });

  test('down is never read: reversing a create drops a table on every migration ever', async () => {
    const root = await appWith(
      { '0002.sql': 'alter table t add column c text;\n-- down\nalter table t drop column c;\n' },
      '0',
    );
    expect(await checkRollingMigrations(root)).toEqual([]);
  });

  test('--rolling-unsafe writes the marker into the file, so the rail agrees', async () => {
    const migration = generateMigration({
      entities: [
        {
          name: 'post',
          table: 'post',
          primaryKey: [],
          columns: [],
          indexes: [],
        },
      ],
      current: snapshotOf([
        {
          name: 'post',
          table: 'post',
          primaryKey: [],
          indexes: [],
          columns: [
            {
              property: 'body',
              column: 'body',
              kind: 'text',
              notNull: false,
              primaryKey: false,
              unique: false,
              hasDefault: false,
              check: null,
              references: null,
            },
          ],
        },
      ]),
      name: 'stop first',
      allowDestructive: true,
      rollingUnsafe: true,
    });
    const sql = migrationSql(migration);
    expect(sql).toContain(`\n${ROLLING_UNSAFE_MARKER}\n`);
    const root = await appWith({ [`${migration.id}.sql`]: sql }, '0');
    expect(await checkRollingMigrations(root)).toEqual([]);
    const stripped = sql.replace(`${ROLLING_UNSAFE_MARKER}\n`, '');
    expect(
      (await checkRollingMigrations(await appWith({ '0002.sql': stripped }, '0'))).length,
    ).toBe(1);
  });

  test('it runs in the drift step', async () => {
    const root = await appWith({ '0002_drop.sql': DROP }, '0');
    await Bun.write(join(root, APP_CONFIG_FILE), 'export const config = {};\n');
    const drift = VERIFY_STEPS.find((step) => step.name === 'drift');
    const outcome = await drift?.run({ root, env: {} } as never);
    expect(JSON.stringify(outcome?.findings)).toContain('X_MIGRATION_ROLLING_UNSAFE');
  });
});
