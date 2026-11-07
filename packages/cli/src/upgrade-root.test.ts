// The upgrade root never climbs out of the repository the cwd is in, a submodule or worktree (whose
// `.git` is a file) included, and a malformed manifest above refuses with a code, not a SyntaxError.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; each scratch tree must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { findUpgradeRoot } from './upgrade-root';

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

const PINNED = JSON.stringify({ dependencies: { '@ultimat3/core': '1.0.0' } });

/** An outer repository whose root manifest claims `sub/`, which holds pins of its own. */
async function nested(outerManifest: string, subGit: 'file' | 'dir' | 'none'): Promise<string> {
  const outer = await mkdtemp(join(tmpdir(), 'x-test-upgrade-root-'));
  scratch.push(outer);
  await Bun.write(join(outer, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await Bun.write(join(outer, 'package.json'), outerManifest);
  await Bun.write(join(outer, 'sub', 'package.json'), PINNED);
  if (subGit === 'file')
    await Bun.write(join(outer, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
  if (subGit === 'dir')
    await Bun.write(join(outer, 'sub', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return outer;
}

const CLAIMING = JSON.stringify({ workspaces: ['sub'], dependencies: {} });

describe('unit · findUpgradeRoot', () => {
  test('a workspace member climbs to the root that claims it, inside one repository', async () => {
    const outer = await nested(CLAIMING, 'none');
    expect(await findUpgradeRoot(join(outer, 'sub'))).toEqual({ dir: outer, app: false });
  });

  test('a submodule (.git is a file) stops at its own root', async () => {
    const outer = await nested(CLAIMING, 'file');
    expect(await findUpgradeRoot(join(outer, 'sub'))).toEqual({
      dir: join(outer, 'sub'),
      app: false,
    });
  });

  test('a nested repository (.git is a directory) stops at its own root', async () => {
    const outer = await nested(CLAIMING, 'dir');
    expect((await findUpgradeRoot(join(outer, 'sub'))).dir).toBe(join(outer, 'sub'));
  });

  test('a malformed manifest above refuses with X_UPGRADE_PIN_UNREADABLE', async () => {
    const outer = await nested('{ "workspaces": [', 'none');
    const refusal = await findUpgradeRoot(join(outer, 'sub')).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UltimateError);
    expect((refusal as UltimateError).code).toBe('X_UPGRADE_PIN_UNREADABLE');
  });
});
