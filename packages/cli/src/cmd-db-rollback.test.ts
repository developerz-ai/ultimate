// `x db rollback [--steps n]`: the `-- down` half every generated migration carries, run by a
// command — on the embedded database of a checkout with no `x dev`, refused outside development
// until the operator names each migration, and never over a migration that has no `down`.

import { describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { exec } from './exec';
import { msg } from './messages';
import { MIGRATIONS_DIR } from './migrations';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by-fixture';

/** Two embedded boots and a schema-dump replay per case: a hang detector, never a budget. */
const EMBEDDED_MS = 180_000;

const ctxFor = (
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env,
  bunVersion: REQUIRED_BUN,
});

const GADGETS = '0001_gadgets';
const WIDGETS = '0002_widgets';

/** An app with two reversible migrations, both applied to its own embedded database. */
async function migratedApp(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-db-rollback-'));
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(root, 'apps/web/shared/app-name.ts'), "export const APP_NAME = 'rb';\n");
  await Bun.write(
    join(root, MIGRATIONS_DIR, `${GADGETS}.sql`),
    'create table gadgets (id uuid primary key);\n-- down\ndrop table gadgets;\n',
  );
  await Bun.write(
    join(root, MIGRATIONS_DIR, `${WIDGETS}.sql`),
    'create table widgets (id uuid primary key);\n-- down\ndrop table widgets;\n',
  );
  const migrated = await dbCommand.run(ctxFor(['db', 'migrate'], root));
  expect((migrated.data as { applied: string[] }).applied).toEqual([GADGETS, WIDGETS]);
  return root;
}

describe('unit · x db rollback', () => {
  test(
    'reverses the newest applied migration by default, and --steps reverses that many',
    async () => {
      const root = await migratedApp();
      try {
        const one = await dbCommand.run(ctxFor(['db', 'rollback'], root));
        expect(one.findings ?? []).toEqual([]);
        expect(one.ok).toBe(true);
        expect(one.summary).toBe(msg('cli.db.rollback.done', { count: 1, ids: WIDGETS }));
        expect(one.data).toEqual({
          reverted: [WIDGETS],
          steps: 1,
          files: [`${MIGRATIONS_DIR}/${WIDGETS}.sql`],
        });
        // The file is still on disk, so the next migrate re-applies it: the line says so.
        expect(one.lines?.join('\n')).toContain(`${MIGRATIONS_DIR}/${WIDGETS}.sql`);
        expect(one.lines?.join('\n')).toContain('x db migrate');

        // The `down` really ran: re-applying `create table widgets` would fail over a live table.
        const again = await dbCommand.run(ctxFor(['db', 'migrate'], root));
        expect((again.data as { applied: string[] }).applied).toEqual([WIDGETS]);

        const both = await dbCommand.run(ctxFor(['db', 'rollback', '--steps', '2'], root));
        expect((both.data as { reverted: string[] }).reverted).toEqual([WIDGETS, GADGETS]);

        const none = await dbCommand.run(ctxFor(['db', 'rollback'], root));
        expect(none.ok).toBe(true);
        expect(none.summary).toBe(msg('cli.db.rollback.none'));
        expect((none.data as { reverted: string[] }).reverted).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    EMBEDDED_MS,
  );

  test(
    'outside development it is refused until ROLLBACK_ALLOW_DESTRUCTIVE names each migration',
    async () => {
      const root = await migratedApp();
      try {
        const production = { ULTIMATE_ENV: 'production' };
        const refused = await dbCommand.run(
          ctxFor(['db', 'rollback', '--steps', '2'], root, production),
        );
        expect(refused.ok).toBe(false);
        expect(refused.findings?.map((finding) => finding.code)).toEqual([
          'X_MIGRATION_ROLLBACK_DESTRUCTIVE',
        ]);
        expect(refused.findings?.[0]?.fix).toStartWith(
          `ROLLBACK_ALLOW_DESTRUCTIVE=${WIDGETS},${GADGETS} x db rollback --steps 2 --json`,
        );

        // Naming one of two is not consent for two — and nothing was reversed by the refusals.
        const half = await dbCommand.run(
          ctxFor(['db', 'rollback', '--steps', '2'], root, {
            ...production,
            ROLLBACK_ALLOW_DESTRUCTIVE: WIDGETS,
          }),
        );
        expect(half.findings?.[0]?.code).toBe('X_MIGRATION_ROLLBACK_DESTRUCTIVE');
        expect(half.findings?.[0]?.cause).toContain(GADGETS);

        const named = await dbCommand.run(
          ctxFor(['db', 'rollback', '--steps', '2'], root, {
            ...production,
            ROLLBACK_ALLOW_DESTRUCTIVE: `${WIDGETS}, ${GADGETS}`,
          }),
        );
        expect(named.findings ?? []).toEqual([]);
        expect((named.data as { reverted: string[] }).reverted).toEqual([WIDGETS, GADGETS]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    EMBEDDED_MS,
  );

  test(
    'a migration with no down half is refused, and its ledger row stays',
    async () => {
      const root = await migratedApp();
      try {
        await Bun.write(
          join(root, MIGRATIONS_DIR, '0003_notes.sql'),
          'create table notes (id uuid primary key);\n',
        );
        await dbCommand.run(ctxFor(['db', 'migrate'], root));

        const refused = await dbCommand.run(ctxFor(['db', 'rollback'], root));
        expect(refused.ok).toBe(false);
        expect(refused.findings?.map((finding) => finding.code)).toEqual([
          'X_MIGRATION_IRREVERSIBLE',
        ]);
        expect(refused.findings?.[0]?.fix).toContain(`${MIGRATIONS_DIR}/0003_notes.sql`);
        // Still applied: a migrate finds nothing to do.
        const after = await dbCommand.run(ctxFor(['db', 'migrate'], root));
        expect((after.data as { applied: string[] }).applied).toEqual([]);

        // An EMPTY down under the marker is a reversal that needs no statement, which is what
        // `x db gen` writes for a deferred `validate constraint` (measured on the reference app:
        // the generated `_concurrently` half was refused as irreversible). It is reversed — and,
        // being the half that runs outside the transaction, the line says what is still applied.
        await Bun.write(
          join(root, MIGRATIONS_DIR, '0003_notes.sql'),
          'create table notes (id uuid primary key);\n-- down\ndrop table notes;\n',
        );
        await Bun.write(
          join(root, MIGRATIONS_DIR, '0004_notes_concurrently.sql'),
          '-- transaction: false\nselect 1;\n\n-- down\n',
        );
        await dbCommand.run(ctxFor(['db', 'migrate'], root));
        const half = await dbCommand.run(ctxFor(['db', 'rollback'], root));
        expect(half.findings ?? []).toEqual([]);
        expect((half.data as { reverted: string[] }).reverted).toEqual(['0004_notes_concurrently']);
        expect(half.lines?.join('\n')).toContain('the migration before it is still applied');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    EMBEDDED_MS,
  );

  test('--steps takes a positive integer, and the flag belongs to rollback alone', () => {
    expect(thrownBy(() => parseArgs(['db', 'migrate', '--steps', '2'], SPECS)).code).toBe(
      'X_CLI_BAD_FLAG',
    );
  });

  test('--steps 0 is refused before any database is opened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-db-rollback-flag-'));
    try {
      await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'f' };\n");
      const failure = await dbCommand.run(ctxFor(['db', 'rollback', '--steps', '0'], root)).then(
        () => expect.unreachable('--steps 0 was accepted'),
        (error: unknown) => error as { code: string; fix: string },
      );
      expect(failure.code).toBe('X_CLI_BAD_FLAG');
      expect(failure.fix).toBe('x db rollback --steps 1');
      expect(await Bun.file(join(root, '.x/pgdata/PG_VERSION')).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
