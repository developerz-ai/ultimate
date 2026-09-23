// `x new`'s refusals, RUN rather than read: a fix line is a command, so each test executes the one
// it was handed and asserts the effect. Split from `cmd-new.test.ts` at its size ceiling.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete; `node:fs` owns the throwaway parent.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { newCommand } from './cmd-new';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const noShell: Runner = async (command) => ({
  command,
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const contextFor = (argv: readonly string[], cwd: string, runner: Runner = noShell) =>
  ({
    args: parseArgs(argv, SPECS),
    cwd,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  }) satisfies CommandContext;

/** The fix line as argv: the command before a `#` comment, `x` dropped, words split. */
const argvOf = (fix: string): readonly string[] =>
  (fix.split('#')[0] ?? '').trim().split(/\s+/).slice(1);

const withParent = async (body: (parent: string) => Promise<void>): Promise<void> => {
  const parent = mkdtempSync(join(tmpdir(), 'x-new-refusal-'));
  try {
    await body(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
};

describe('unit · x new refuses what it cannot scaffold, and its fix runs', () => {
  test('a name with no letters or digits is X_APP_NAME_EMPTY, and nothing is written', async () => {
    await withParent(async (parent) => {
      const refusal = await newCommand
        .run(contextFor(['new', '!!!', '--no-git'], parent))
        .then(() => expect.unreachable('x new !!! scaffolded'))
        .catch((error: unknown) => error as { code: string; cause: string; fix: string });
      expect(refusal.code).toBe('X_APP_NAME_EMPTY');
      expect(refusal.cause).toBe('"!!!" has no letters or digits, so it names no directory');
      expect(refusal.fix).toBe('x new <name-with-letters> --no-git');
      expect(readdirSync(parent)).toEqual([]);
    });
  });

  test('the conflict fix keeps every flag the caller set, and running it scaffolds that app', async () => {
    await withParent(async (parent) => {
      const argv = ['new', 'demo app', '--dir', 'nested', '--no-example', '--no-git'];
      await Bun.write(join(parent, 'nested', 'demo-app', 'KEEP.txt'), 'kept');
      const refused = await newCommand.run(contextFor(argv, parent));
      const fix = refused.findings?.[0]?.fix ?? '';
      expect(fix).toBe(
        'x new demo-app --dir nested --no-example --no-git --force   # or choose another name',
      );

      const ran = await newCommand.run(contextFor(argvOf(fix), parent));
      expect(ran.ok).toBe(true);
      const target = join(parent, 'nested', 'demo-app');
      expect(existsSync(join(target, 'app.config.ts'))).toBe(true);
      // `--no-example` survived the round trip: no example slice was written.
      expect(existsSync(join(target, 'apps/web/app/post'))).toBe(false);
      expect(existsSync(join(parent, 'demo-app'))).toBe(false);
    });
  }, 30_000);

  test('--force into a directory that already held files never commits them', async () => {
    await withParent(async (parent) => {
      await Bun.write(join(parent, 'demo-app', 'mine.txt'), 'not the scaffold');
      const ran: string[] = [];
      const recording: Runner = async (command, options) => {
        ran.push(command.join(' '));
        return noShell(command, options);
      };
      const result = await newCommand.run(
        contextFor(['new', 'demo-app', '--force'], parent, recording),
      );
      expect(result.ok).toBe(true);
      expect(ran.filter((command) => command.startsWith('git'))).toEqual([]);
      const git = (result.data as { git: { committed: boolean; problem: string } }).git;
      expect(git.committed).toBe(false);
      expect(git.problem).toContain('already existed');
    });
  }, 30_000);

  test('a hand-run line quotes the directory, so a path with a space is one argument', async () => {
    await withParent(async (parent) => {
      const failing: Runner = async (command) => ({
        command,
        code: 1,
        ok: false,
        stdout: '',
        stderr: 'fatal: no git',
        durationMs: 0,
      });
      const result = await newCommand.run(
        contextFor(['new', 'demo-app', '--dir', 'with space'], parent, failing),
      );
      const run = result.lines?.find((line) => line.includes('run: cd'));
      expect(run).toContain(`cd '${join(parent, 'with space', 'demo-app')}' &&`);
    });
  }, 30_000);
});
