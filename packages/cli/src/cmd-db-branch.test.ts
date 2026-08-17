// `x db branch` end to end, through the real command: a VERB decides what runs, and a branch name
// can never be one. Every case here is the defect in a different disguise — the argument used to
// BE the branch name, so `x db branch ls --json` (a `fix:` line the planned `x branch`,
// `X_DB_BRANCH_FAILED` and `@ultimat3/db`'s own X_BRANCH_EXISTS all hand out) cloned a database
// called `ls` and returned no listing. Embedded only: no case here needs a server.

import { describe, expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: '1.3.0',
});

/** An app root whose embedded database exists on disk, so `x db branch` has something to clone. */
async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-branch-'));
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  await Bun.write(join(dir, '.x', 'pgdata', 'PG_VERSION'), '15\n');
  return dir;
}

const thrownBy = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('unit · x db branch', () => {
  test('`ls` LISTS — it is never read as the name of a branch to create', async () => {
    const root = await appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'branch', 'ls'], root));
      expect(existsSync(join(root, '.x', 'pgdata-ls'))).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('create, then ls, then drop — the branch the verbs name is the same one', async () => {
    const root = await appRoot();
    try {
      const created = await dbCommand.run(ctxFor(['db', 'branch', 'create', 'feat-x'], root));
      expect(created.ok).toBe(true);
      expect(existsSync(join(root, '.x', 'pgdata-feat-x'))).toBe(true);

      const listed = await dbCommand.run(ctxFor(['db', 'branch', 'ls'], root));
      expect(listed.data).toMatchObject([{ name: 'feat-x' }]);

      const dropped = await dbCommand.run(ctxFor(['db', 'branch', 'drop', 'feat-x'], root));
      expect(dropped.ok).toBe(true);
      expect(existsSync(join(root, '.x', 'pgdata-feat-x'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the OLD bare-name form refuses, and hands back the invocation that means it', async () => {
    const root = await appRoot();
    try {
      const failure = await thrownBy(
        dbCommand.run(ctxFor(['db', 'branch', 'feat-new-billing'], root)),
      );
      expect(failure).toBeUltimateError('X_CLI_UNKNOWN_COMMAND');
      // Not a page to read: the caller's own branch name, in the command that creates it.
      expect((failure as { fix: string }).fix).toBe('x db branch create feat-new-billing');
      expect(existsSync(join(root, '.x', 'pgdata-feat-new-billing'))).toBe(false);

      // A near miss on a verb is a typo, not a branch name — and the fix is one `x`, not two.
      const typo = await thrownBy(dbCommand.run(ctxFor(['db', 'branch', 'lst'], root)));
      expect((typo as { fix: string }).fix).toBe('x db branch ls --json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no verb at all refuses with the closed set, and drop needs a name', async () => {
    const root = await appRoot();
    try {
      const bare = await thrownBy(dbCommand.run(ctxFor(['db', 'branch'], root)));
      expect(bare).toBeUltimateError('X_CLI_BAD_FLAG');
      expect((bare as { cause: string }).cause).toContain('<ls|create|drop>');
      expect((bare as { fix: string }).fix).toBe('x db branch ls --json');

      const unnamed = await thrownBy(dbCommand.run(ctxFor(['db', 'branch', 'drop'], root)));
      expect(unnamed).toBeUltimateError('X_CLI_BAD_FLAG');
      expect((unnamed as { cause: string }).cause).toContain('x db branch drop');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dropping a name that is not a branch of this database is refused, not attempted', async () => {
    const root = await appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'branch', 'drop', 'pgdata'], root));
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_DB_BRANCH_FAILED');
      expect(result.findings?.[0]?.fix).toBe('x db branch ls --json');
      // The dev database is one path resolution away from a branch directory, and it survives.
      expect(existsSync(join(root, '.x', 'pgdata'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unrecognised x db subcommand refuses; it is never re-read as a branch name', async () => {
    // The fall-through this replaces was `return runBranch(ctx, root, argument ?? 'preview')`
    // after the last `if`, so ANY subcommand the parser had not already refused became a branch.
    const root = await appRoot();
    try {
      const ctx = ctxFor(['db', 'migrate'], root);
      const failure = await thrownBy(
        dbCommand.run({ ...ctx, args: { ...ctx.args, subcommand: 'branhc' } }),
      );
      expect(failure).toBeUltimateError('X_CLI_UNKNOWN_COMMAND');
      expect((failure as { cause: string }).cause).toContain('gen, migrate, reset');
      // Help, not the nearest name: `x db branch` needs a word this refusal does not have, and a
      // suggestion that refuses in turn is not a fix. `x db --help` is refused by the parser.
      expect((failure as { fix: string }).fix).toBe('x help db');
      expect(existsSync(join(root, '.x', 'pgdata-preview'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
