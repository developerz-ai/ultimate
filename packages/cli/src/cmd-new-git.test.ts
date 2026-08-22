// The repository `x new` leaves behind, and the one thing it must never do: fail the command.
//
// Three surfaces of this CLI already assumed a repository and answered `not a git repository` in
// a fresh scaffold — `x affected`, `x ci` and `x pr`. The fourth, `X_ROUTE_FILE_INVALID`, is now a
// plain `mv -n` and needs no repository at all. Its own file because `cmd-new.test.ts` is at
// the 500-line ceiling and this is a subject of its own, not a case of the ones there.

import { describe, expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRepository, newCommand, SKIPPED } from './cmd-new';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

describe('unit · x new · the repository it initializes', () => {
  /** Every argv the command handed the runner, in order — the shape a fake `Runner` exists for. */
  const recording = (): { readonly calls: string[][]; readonly runner: Runner } => {
    const calls: string[][] = [];
    const runner: Runner = async (command, options) => {
      calls.push([...command, `@${options.cwd}`]);
      return {
        command,
        code: 0,
        ok: true,
        stdout: '',
        stderr: '',
        durationMs: 0,
      };
    };
    return { calls, runner };
  };

  test('init, add and commit run in that order, in the directory it just wrote', async () => {
    const { calls, runner } = recording();
    expect(await initRepository(runner, '/tmp/app')).toEqual({
      initialized: true,
      committed: true,
      problem: null,
    });
    expect(calls).toEqual([
      ['git', 'init', '@/tmp/app'],
      ['git', 'add', '-A', '@/tmp/app'],
      ['git', 'commit', '-m', 'x new', '@/tmp/app'],
    ]);
  });

  // A box with no configured `user.email` cannot commit, and the app is already on disk by then —
  // so the tree is the verdict and the repository is data. `ok: false` here would delete a working
  // scaffold's exit code over a git config.
  test('a commit that cannot run leaves the app written and says what to run', async () => {
    const runner: Runner = async (command) => ({
      command,
      code: command.includes('commit') ? 128 : 0,
      ok: !command.includes('commit'),
      stdout: '',
      stderr: 'Author identity unknown\nfatal: unable to auto-detect email address',
      durationMs: 0,
    });
    const outcome = await initRepository(runner, '/tmp/app');
    expect(outcome.initialized).toBe(true);
    expect(outcome.committed).toBe(false);
    expect(outcome.problem).toContain('Author identity unknown');
  });

  // `exec` REFUSES a missing program by throwing, so the absent-git path is a throw and not an
  // exit code — and the thrown value goes through core's renderer, never `${error}`.
  test('a machine with no git is reported, never thrown out of x new', async () => {
    const runner: Runner = () => Promise.reject(new RangeError('Executable not found in $PATH'));
    const outcome = await initRepository(runner, '/tmp/app');
    expect(outcome).toEqual({
      initialized: false,
      committed: false,
      // `renderThrowable`'s own spelling, class name and all — asserted verbatim so a change to
      // how a thrown value is rendered cannot quietly become `[object Object]` here.
      problem: 'RangeError: Executable not found in $PATH',
    });
  });

  // The report's git half, driven by a fake `Runner` rather than by the box's own git config: the
  // real path is green on a laptop with a `user.email` and red on a CI runner without one, so this
  // is the only way the two lines can be asserted verbatim anywhere.
  test('a commit that cannot run adds two report lines: the reason, then the commands', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-git-'));
    try {
      const runner: Runner = async (command) => ({
        command,
        code: command.includes('commit') ? 128 : 0,
        ok: !command.includes('commit'),
        stdout: '',
        stderr: 'Author identity unknown',
        durationMs: 0,
      });
      const written = await newCommand.run({
        args: parseArgs(['new', 'unsigned-app', '--no-example'], SPECS),
        cwd: parent,
        runner,
        env: {},
        bunVersion: '1.3.0',
      });
      const target = join(parent, 'unsigned-app');
      expect(written.ok).toBe(true);
      expect(written.lines?.slice(1)).toEqual([
        '  no repository — git commit -m x new: Author identity unknown',
        `  run: cd ${target} && git init && git add -A && git commit -m 'x new'`,
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  test('x new leaves a real repository behind, and --no-git leaves a bare directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-git-'));
    try {
      const ctx = (argv: readonly string[]): CommandContext => ({
        args: parseArgs(argv, SPECS),
        cwd: parent,
        runner: exec,
        env: {},
        bunVersion: '1.3.0',
      });
      const withGit = await newCommand.run(ctx(['new', 'repo-app', '--no-example']));
      expect(withGit.ok).toBe(true);
      expect((withGit.data as { git: { initialized: boolean } }).git.initialized).toBe(true);
      expect(existsSync(join(parent, 'repo-app', '.git'))).toBe(true);

      const bare = await newCommand.run(ctx(['new', 'bare-app', '--no-example', '--no-git']));
      expect(bare.ok).toBe(true);
      expect((bare.data as { git: unknown }).git).toEqual({
        initialized: false,
        committed: false,
        problem: SKIPPED,
      });
      expect(existsSync(join(parent, 'bare-app', '.git'))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);
});
