// `baseRef()` and the one fetch under it, against real clones of a throwaway upstream: a full
// clone that lost a ref gets it back WITHOUT turning shallow (a `--depth=1` fetch there wrote
// `.git/shallow` and broke the developer's `git pull`), and CI's shallow checkout keeps depth 1.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { BASE_REF, baseRef, FETCH_MAIN } from './base-ref';
import { fetchFromOrigin, type GitRunner } from './git-fetch';
import { git } from './release-due-git';
import { REPO_SCAN_TIMEOUT_MS, run } from './run';

// Spawns real git processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const must = async (args: readonly string[], cwd: string): Promise<string> => {
  const out = await git(
    ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    cwd,
  );
  expect(out.ok, out.output).toBe(true);
  return out.output;
};

/** A non-bare upstream on `main`: three commits, `v1` on the middle one. */
async function upstream(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'base-ref-upstream-'));
  made.push(dir);
  await must(['init', '--quiet', '--initial-branch=main'], dir);
  for (const n of [1, 2, 3]) {
    await Bun.write(join(dir, 'f.txt'), `${n}\n`);
    await must(['add', 'f.txt'], dir);
    await must(['commit', '--quiet', '-m', `c${n}`], dir);
    if (n === 2) await must(['tag', 'v1'], dir);
  }
  return dir;
}

/** A clone of `from`, full or at depth 1, with `origin/main` and the `v1` tag deleted. */
async function cloneOf(from: string, kind: 'full' | 'shallow') {
  const parent = await mkdtemp(join(tmpdir(), `base-ref-${kind}-`));
  made.push(parent);
  const dir = join(parent, 'clone');
  // A file URL, never a path: git honours `--depth` only over a transport, not a local copy.
  const url = Bun.pathToFileURL(from).href;
  await must(['clone', '--quiet', ...(kind === 'shallow' ? ['--depth=1'] : []), url, dir], parent);
  await must(['update-ref', '-d', 'refs/remotes/origin/main'], dir);
  await git(['tag', '-d', 'v1'], dir);
  const shallow = async (): Promise<boolean> =>
    (await must(['rev-parse', '--is-shallow-repository'], dir)).trim() === 'true';
  expect(await shallow()).toBe(kind === 'shallow');
  return { dir, shallow };
}

/** The real runner, recording every `git fetch` it was handed. */
function recording(): { readonly runner: GitRunner; readonly fetches: string[][] } {
  const fetches: string[][] = [];
  const runner: GitRunner = (command, options) => {
    if (command[1] === 'fetch') fetches.push([...command]);
    return run(command, options);
  };
  return { runner, fetches };
}

describe('baseRef in a real clone', () => {
  test('a full clone without origin/main fetches it and stays a full clone', async () => {
    const clone = await cloneOf(await upstream(), 'full');
    const { runner, fetches } = recording();
    expect(await baseRef(clone.dir, runner)).toBe(BASE_REF);
    expect(await Bun.file(join(clone.dir, '.git', 'shallow')).exists()).toBe(false);
    expect(await clone.shallow()).toBe(false);
    // Non-vacuity: the ref was missing, so the fetch really ran — with no depth.
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).not.toContain('--depth=1');
  });

  test('a shallow clone without origin/main fetches it at depth 1 and resolves it', async () => {
    const clone = await cloneOf(await upstream(), 'shallow');
    const { runner, fetches } = recording();
    expect(await baseRef(clone.dir, runner)).toBe(BASE_REF);
    expect(await clone.shallow()).toBe(true);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain('--depth=1');
  });

  test('the command a fix line hands a person is safe in a full clone: no depth', () => {
    expect(FETCH_MAIN).toBe('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main');
  });
});

describe('fetchFromOrigin, the one fetch every root script makes', () => {
  test('a tag fetched into a full clone lands without making it shallow', async () => {
    const clone = await cloneOf(await upstream(), 'full');
    const tag = '+refs/tags/v1:refs/tags/v1';
    expect((await fetchFromOrigin(clone.dir, ['--quiet', '--no-tags', 'origin', tag])).ok).toBe(
      true,
    );
    expect((await git(['rev-parse', '--verify', '--quiet', 'refs/tags/v1'], clone.dir)).ok).toBe(
      true,
    );
    expect(await clone.shallow()).toBe(false);
  });
});
