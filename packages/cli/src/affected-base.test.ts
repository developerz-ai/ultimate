// The default `--base`: the remote-tracking default branch, never a stale local `main`. Pinned
// twice — over a fake `Runner` for the order of the fallbacks, and over a real clone whose local
// `main` lags origin, which is the field report this exists for.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway repos.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { changedFiles } from './affected';
import { DEFAULT_BASE, defaultBase, fetchFixFor } from './affected-base';
import type { ExecResult, Runner } from './exec';
import { exec } from './exec';

const SYMREF = 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD';
const ORIGIN_MAIN = 'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}';

const fake = (replies: Readonly<Record<string, string>>): Runner => {
  return async (command): Promise<ExecResult> => {
    const stdout = replies[command.join(' ')];
    return {
      command,
      code: stdout === undefined ? 1 : 0,
      ok: stdout !== undefined,
      stdout: stdout ?? '',
      stderr: '',
      durationMs: 1,
    };
  };
};

describe('unit · the default base is the remote-tracking default branch', () => {
  test("origin/HEAD's target wins, whatever the branch is called", async () => {
    expect(await defaultBase(fake({ [SYMREF]: 'origin/trunk\n' }), '/repo')).toBe('origin/trunk');
  });

  test('a remote with no origin/HEAD still answers origin/main', async () => {
    expect(await defaultBase(fake({ [ORIGIN_MAIN]: 'abc\n' }), '/repo')).toBe('origin/main');
  });

  test('local main only when there is no remote at all', async () => {
    expect(await defaultBase(fake({}), '/repo')).toBe(DEFAULT_BASE);
  });

  test('the fetch fix refreshes a remote-tracking ref, never creates a branch named origin/…', () => {
    expect(fetchFixFor('origin/main')).toBe('git fetch --no-tags origin main');
    expect(fetchFixFor('main')).toBe('git fetch --no-tags origin main:main');
  });
});

/** Real git through the CLI's own runner — the one every command spawns it with. */
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const run = await exec(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
  });
  if (!run.ok) expect.unreachable(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
};

describe('unit · a checkout whose local main lags origin', () => {
  test('the diff holds only this branch’s work, not what origin merged since', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-affected-base-'));
    try {
      const upstream = join(dir, 'upstream.git');
      const clone = join(dir, 'clone');
      const peer = join(dir, 'peer');
      await git(dir, 'init', '--quiet', '--bare', '-b', 'main', upstream);
      await git(dir, 'clone', '--quiet', upstream, peer);
      await Bun.write(join(peer, 'a.ts'), 'export const a = 1;\n');
      await git(peer, 'add', '-A');
      await git(peer, 'commit', '--quiet', '-m', 'one');
      await git(peer, 'push', '--quiet', 'origin', 'HEAD:main');
      await git(dir, 'clone', '--quiet', upstream, clone);
      // Someone merges upstream; this checkout fetches but never pulls, so local main is stale.
      await Bun.write(join(peer, 'merged.ts'), 'export const m = 1;\n');
      await git(peer, 'add', '-A');
      await git(peer, 'commit', '--quiet', '-m', 'merged upstream');
      await git(peer, 'push', '--quiet', 'origin', 'HEAD:main');
      await git(clone, 'fetch', '--quiet', 'origin');
      await git(clone, 'checkout', '--quiet', '-b', 'feature', 'origin/main');
      await Bun.write(join(clone, 'mine.ts'), 'export const x = 1;\n');
      await git(clone, 'add', '-A');
      await git(clone, 'commit', '--quiet', '-m', 'mine');

      const base = await defaultBase(exec, clone);
      expect(base).toBe('origin/main');
      const files = await changedFiles(exec, {
        cwd: clone,
        command: 'affected',
        selection: { base, dirty: false },
      });
      expect(files).toEqual(['mine.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
