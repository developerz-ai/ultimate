// What `x db gen` says it wrote, and what it refuses to write over: a diff that needs a step
// outside the transaction is two migrations and the summary names both; an applied migration
// edited since is `X_MIGRATION_CONFLICT` before a byte of the schema dump moves.

import { describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { entity, text, uuid } from '@ultimat3/entity';
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { refuseEdited } from './db-applied-edits';
import { SCHEMA_DUMP_DIR } from './db-schema-dump';
import { lockPath } from './dev-lock';
import { exec } from './exec';
import { msg } from './messages';
import { MIGRATIONS_DIR } from './migrations';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by-fixture';

/** A scratch replay per `gen` and an embedded boot per `migrate`: a hang detector, not a budget. */
const EMBEDDED_MS = 180_000;

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-gen-written-'));
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(dir, 'apps/web/shared/app-name.ts'), "export const APP_NAME = 'gen';\n");
  return dir;
}

describe('unit · x db gen names every migration it wrote', () => {
  test(
    'a column beside a concurrent index is two migrations, and the summary names both',
    async () => {
      const restoreEntities = isolateEntityRegistry();
      const root = await appRoot();
      try {
        entity('gen_written_runs', {
          columns: { id: uuid().primaryKey(), status: text({ max: 20 }) },
        });
        await dbCommand.run(ctxFor(['db', 'gen', 'create runs'], root));
        restoreEntities();
        const restoreSecond = isolateEntityRegistry();
        try {
          entity('gen_written_runs', {
            columns: {
              id: uuid().primaryKey(),
              status: text({ max: 20 }),
              note: text({ max: 20 }).nullable(),
            },
            indexes: [{ on: ['status'], concurrently: true }],
          });
          const result = await dbCommand.run(ctxFor(['db', 'gen', 'runs gain a note'], root));
          const { migration, followUp } = result.data as { migration: string; followUp: string };
          expect(followUp).toBe(`${migration}_concurrently`);
          expect(result.summary).toBe(
            msg('cli.db.gen.writtenPairTables', {
              id: migration,
              followUp,
              tables: 'gen_written_runs',
            }),
          );
          expect(result.summary).toContain(followUp);
        } finally {
          restoreSecond();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    EMBEDDED_MS,
  );
});

describe('unit · x db gen never blesses an edited applied migration', () => {
  test(
    'the edit is X_MIGRATION_CONFLICT, and the schema dump keeps the SQL that was applied',
    async () => {
      const restoreEntities = isolateEntityRegistry();
      const root = await appRoot();
      try {
        entity('gen_edited_notes', { columns: { id: uuid().primaryKey() } });
        const first = await dbCommand.run(ctxFor(['db', 'gen', 'add notes'], root));
        const id = (first.data as { migration: string }).migration;
        await dbCommand.run(ctxFor(['db', 'migrate'], root));
        const dump = join(root, SCHEMA_DUMP_DIR, '04_tables/gen_edited_notes.sql');
        const before = await Bun.file(dump).text();

        // What an agent does mid-task: widen the table in the migration it already applied.
        const file = join(root, MIGRATIONS_DIR, `${id}.sql`);
        const sql = await Bun.file(file).text();
        await Bun.write(file, sql.replace('"id" uuid', '"label" text, "id" uuid'));
        expect(await Bun.file(file).text()).not.toBe(sql);

        const result = await dbCommand.run(ctxFor(['db', 'gen'], root));

        expect(result.ok).toBe(false);
        expect(result.findings?.map((finding) => finding.code)).toEqual(['X_MIGRATION_CONFLICT']);
        expect(result.findings?.[0]?.cause).toContain(id);
        expect(await Bun.file(dump).text()).toBe(before);
      } finally {
        restoreEntities();
        rmSync(root, { recursive: true, force: true });
      }
    },
    EMBEDDED_MS,
  );

  test(
    'beside an x dev that does not answer, gen still runs and says the check was skipped',
    async () => {
      const restoreEntities = isolateEntityRegistry();
      const root = await appRoot();
      try {
        entity('gen_unasked_notes', { columns: { id: uuid().primaryKey() } });
        await dbCommand.run(ctxFor(['db', 'gen', 'add notes'], root));
        // A data directory and a holder on a port nothing answers: an older CLI's server, or one
        // with no web role. This command is the fix of five errors and must not need a database.
        await Bun.write(join(root, '.x/pgdata/PG_VERSION'), '17\n');
        const lock = { pid: process.pid, port: 1, url: 'http://localhost:1', startedAt: '' };
        await Bun.write(lockPath(join(root, '.x')), JSON.stringify(lock));

        const result = await dbCommand.run(ctxFor(['db', 'gen'], root));

        expect(result.findings ?? []).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.lines?.join('\n')).toContain('were not compared with the ledger');
      } finally {
        restoreEntities();
        rmSync(root, { recursive: true, force: true });
      }
    },
    EMBEDDED_MS,
  );

  const posts = { id: '0001_posts', name: 'posts', up: 'create table posts (id uuid);', down: '' };

  test('only a shipped row whose checksum moved is refused', () => {
    expect(thrownBy(() => refuseEdited([{ id: posts.id, checksum: 'other' }], [posts])).code).toBe(
      'X_MIGRATION_CONFLICT',
    );
    // A row this checkout does not ship is the migrator's refusal (or a rollback), not this one's.
    refuseEdited([{ id: '0009_gone', checksum: 'x' }], [posts]);
  });
});
