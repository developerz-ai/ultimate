// The byte ceiling on `CLAUDE.md`: 16 KB for the root, 24 KB for a package unless pinned, and a
// pinned package file may shrink but never grow.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temp-directory native; each case needs a throwaway repo root on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { claudeMdFindings, PACKAGE_CEILING, ROOT_CEILING } from './claude-md-size';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// The last case reads the real tree, so the file runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const repo = async (files: Readonly<Record<string, number>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'claude-md-size-'));
  roots.push(root);
  for (const [path, bytes] of Object.entries(files)) {
    await Bun.write(join(root, path), 'x'.repeat(bytes));
  }
  return root;
};

const codes = async (
  files: Readonly<Record<string, number>>,
  pins: Readonly<Record<string, number>> = {},
): Promise<readonly string[]> =>
  (await claudeMdFindings(await repo(files), pins)).map((f) => `${f.code} ${f.at ?? ''}`);

describe('the root file', () => {
  test('at the ceiling passes; one byte over is refused, naming the ceiling', async () => {
    expect(await codes({ 'CLAUDE.md': ROOT_CEILING, 'packages/a/CLAUDE.md': 1 })).toEqual([]);
    const root = await repo({ 'CLAUDE.md': ROOT_CEILING + 1, 'packages/a/CLAUDE.md': 1 });
    const [finding] = await claudeMdFindings(root, {});
    expect(finding?.code).toBe('X_CLAUDE_MD_OVERSIZE');
    expect(finding?.cause).toContain('16,385 B');
    expect(finding?.cause).toContain('16,384 B');
  });

  test('a missing root file is unscanned, never a pass', async () => {
    expect(await codes({ 'packages/a/CLAUDE.md': 1 })).toEqual(['X_CLAUDE_MD_UNSCANNED CLAUDE.md']);
  });
});

describe('package files', () => {
  test('under the default ceiling needs no pin', async () => {
    expect(await codes({ 'CLAUDE.md': 1, 'packages/a/CLAUDE.md': PACKAGE_CEILING })).toEqual([]);
  });

  test('over it and unpinned is refused', async () => {
    expect(await codes({ 'CLAUDE.md': 1, 'packages/a/CLAUDE.md': PACKAGE_CEILING + 1 })).toEqual([
      'X_CLAUDE_MD_OVERSIZE packages/a/CLAUDE.md',
    ]);
  });

  test('a pinned file may shrink, and may not grow by one byte', async () => {
    const pins = { 'packages/a/CLAUDE.md': 40_000 };
    expect(await codes({ 'CLAUDE.md': 1, 'packages/a/CLAUDE.md': 39_000 }, pins)).toEqual([]);
    expect(await codes({ 'CLAUDE.md': 1, 'packages/a/CLAUDE.md': 40_001 }, pins)).toEqual([
      'X_CLAUDE_MD_OVERSIZE packages/a/CLAUDE.md',
    ]);
  });

  test('no package file at all is unscanned', async () => {
    expect(await codes({ 'CLAUDE.md': 1 })).toEqual(['X_CLAUDE_MD_UNSCANNED packages/']);
  });
});

test('the tree as committed is within every ceiling', async () => {
  expect(await claudeMdFindings(repoRoot())).toEqual([]);
});
