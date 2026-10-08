// `x db branch` end to end, through the real command: a VERB decides what runs, and a branch name
// can never be one. Every case here is the defect in a different disguise — the argument used to
// BE the branch name, so the fix line of the day — `x db branch ls --json`, handed out then by the
// planned `x branch`, `X_DB_BRANCH_FAILED` and `@ultimat3/db`'s own X_BRANCH_EXISTS (`list` since
// 26.0.0) — cloned a database called `ls` and returned no listing. Embedded only: no case here
// needs a server.

import { describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

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

/** An app root whose embedded database exists on disk, so `x db branch` has something to clone. */
async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-branch-'));
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(dir, '.x', 'pgdata', 'PG_VERSION'), '15\n');
  return dir;
}

const thrownBy = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('unit · x db branch', () => {
  test('`list` LISTS — it is never read as the name of a branch to create', async () => {
    const root = await appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'branch', 'list'], root));
      expect(existsSync(join(root, '.x', 'pgdata-list'))).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.data).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('create, then list, then delete — the branch the verbs name is the same one', async () => {
    const root = await appRoot();
    try {
      const created = await dbCommand.run(ctxFor(['db', 'branch', 'create', 'feat-x'], root));
      expect(created.ok).toBe(true);
      expect(existsSync(join(root, '.x', 'pgdata-feat-x'))).toBe(true);

      const listed = await dbCommand.run(ctxFor(['db', 'branch', 'list'], root));
      expect(listed.data).toMatchObject([{ name: 'feat-x' }]);

      const dropped = await dbCommand.run(ctxFor(['db', 'branch', 'delete', 'feat-x'], root));
      expect(dropped.ok).toBe(true);
      expect(existsSync(join(root, '.x', 'pgdata-feat-x'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The bug this guards: `Number.parseInt(ctx.env['PORT'] ?? '3000', 10)` — the bare form
  // `flag-number.ts` exists to eliminate — put `http://feat.localhost:NaN` in `data.preview`, a
  // machine-readable field naming no port at all.
  test('PORT decides the preview url, and a PORT that is not one fails before the clone', async () => {
    const root = await appRoot();
    try {
      const created = await dbCommand.run(
        ctxFor(['db', 'branch', 'create', 'feat-p'], root, { PORT: '4000' }),
      );
      expect(created.data).toMatchObject({ preview: 'http://feat-p.localhost:4000' });

      const refused = await thrownBy(
        dbCommand.run(ctxFor(['db', 'branch', 'create', 'feat-bad'], root, { PORT: 'abc' })),
      );
      expect(refused).toMatchObject({ code: 'X_PORT_INVALID' });
      // Nothing was cloned: the refusal happens before the branch is made.
      expect(existsSync(join(root, '.x', 'pgdata-feat-bad'))).toBe(false);
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
      expect((typo as { fix: string }).fix).toBe('x db branch list --json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 26.0.0 retired `ls` and `drop` (#709): one verb each, no alias. Both are legal branch NAMES,
  // so the refusal must hand back the replacement verb — never `create drop`, which would clone a
  // database called `drop` for a caller who asked to delete one.
  test('the retired verbs ls and drop are refused, and the fix names list and delete', async () => {
    const root = await appRoot();
    try {
      const ls = await thrownBy(dbCommand.run(ctxFor(['db', 'branch', 'ls'], root)));
      expect(ls).toBeUltimateError('X_CLI_UNKNOWN_COMMAND');
      expect((ls as { fix: string }).fix).toBe('x db branch list --json');

      const drop = await thrownBy(dbCommand.run(ctxFor(['db', 'branch', 'drop', 'feat-x'], root)));
      expect(drop).toBeUltimateError('X_CLI_UNKNOWN_COMMAND');
      expect((drop as { fix: string }).fix).toBe('x db branch delete feat-x');
      expect(existsSync(join(root, '.x', 'pgdata-ls'))).toBe(false);
      expect(existsSync(join(root, '.x', 'pgdata-drop'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no verb at all refuses with the closed set, and delete needs a name', async () => {
    const root = await appRoot();
    try {
      const bare = await thrownBy(dbCommand.run(ctxFor(['db', 'branch'], root)));
      expect(bare).toBeUltimateError('X_CLI_BAD_FLAG');
      expect((bare as { cause: string }).cause).toContain('<list|create|delete>');
      expect((bare as { fix: string }).fix).toBe('x db branch list --json');

      const unnamed = await thrownBy(dbCommand.run(ctxFor(['db', 'branch', 'delete'], root)));
      expect(unnamed).toBeUltimateError('X_CLI_BAD_FLAG');
      expect((unnamed as { cause: string }).cause).toContain('x db branch delete');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deleting a name that is not a branch of this database is refused, not attempted', async () => {
    const root = await appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'branch', 'delete', 'pgdata'], root));
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_DB_BRANCH_FAILED');
      expect(result.findings?.[0]?.fix).toBe('x db branch list --json');
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
