// `x db` runs one migration engine, and this file is what says so. The gen path writes through
// `@ultimat3/db`, migrate and reset go through `serve.ts`'s `runMigrations` — the release phase's
// own function — and nothing anywhere shells out to a second migrator.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchDatabaseName, branchSql, DB_SUBCOMMANDS, dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { exec } from './exec';
import { flagBool, parseArgs } from './parse';
import { SPECS } from './registry';

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: '1.3.0',
});

/** An app root the command will accept: `app.config.ts` is what `requireAppRoot` looks for. */
function appRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-cmd-'));
  Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
}

describe('unit · x db gen', () => {
  test('an unchanged schema generates nothing and still exits ok', async () => {
    const root = appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'gen', 'nothing to do'], root));
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ migration: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--allow-destructive parses, because X_MIGRATION_IRREVERSIBLE tells you to run it', () => {
    const args = parseArgs(['db', 'gen', 'drop it', '--allow-destructive'], SPECS);
    expect(flagBool(args, 'allow-destructive')).toBe(true);
  });
});

describe('unit · x db studio is planned, not a second engine', () => {
  test('it exits X_NOT_IMPLEMENTED with a fix that runs today', async () => {
    const root = appRoot();
    try {
      const failure: unknown = await dbCommand.run(ctxFor(['db', 'studio'], root)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeUltimateError('X_NOT_IMPLEMENTED');
      expect((failure as { fix: string }).fix).toContain('x dev');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('it stays in the subcommand list, so the parser reaches it', () => {
    expect(DB_SUBCOMMANDS).toContain('studio');
  });
});

describe('unit · x db reset', () => {
  test('refuses an external Postgres rather than dropping a database it does not own', async () => {
    const root = appRoot();
    try {
      const ctx = { ...ctxFor(['db', 'reset'], root), env: { DATABASE_URL: 'postgres://x/y' } };
      const failure: unknown = await dbCommand.run(ctx).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeUltimateError('X_NOT_IMPLEMENTED');
      expect((failure as { fix: string }).fix).toContain('x db migrate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('unit · x db branch', () => {
  test('a branch name is sanitised into the database it clones into', () => {
    expect(branchDatabaseName('postly', 'feat/new-thing')).toBe('postly_branch_feat_new_thing');
    expect(branchSql('postly', 'postly_branch_x')).toBe(
      'CREATE DATABASE "postly_branch_x" TEMPLATE "postly"',
    );
  });
});

describe('unit · one engine, everywhere', () => {
  test('no shipped source spawns a second migrator', async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob('packages/*/src/**/*.ts').scan({
      cwd: join(import.meta.dir, '..', '..', '..'),
      absolute: true,
    })) {
      if (file.includes('.test.')) continue;
      // The argv form, not the word: this file and `cmd-db.ts` both name drizzle-kit in prose to
      // say it is gone, and a gate that cannot tell prose from a spawn would forbid saying so.
      if ((await Bun.file(file).text()).includes("'drizzle-kit'")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("migrate and reset route through the release phase's own function", async () => {
    const source = await Bun.file(join(import.meta.dir, 'cmd-db.ts')).text();
    // Structural, because the alternative is a second migrator nobody notices: the moment this
    // file stops importing `runMigrations`, `x db migrate` and `ROLE=migrate` are two engines again.
    expect(source).toContain("import { runMigrations } from './serve'");
  });
});
