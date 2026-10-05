// The enforcement half of `scripts/root-bin.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so a root `bin/` coming back fails `bun run verify` with no extra wiring.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temp-directory native; each case needs a throwaway repo root on disk.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { REPLACEMENTS, rootBinFindings } from './root-bin';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const repo = async (files: readonly string[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'root-bin-'));
  roots.push(root);
  await Bun.write(join(root, 'package.json'), '{}');
  for (const path of files) await Bun.write(join(root, path), '#!/usr/bin/env bash\n');
  return root;
};

describe('a root bin/', () => {
  test('absent passes', async () => {
    expect(await rootBinFindings(await repo(['scripts/setup.ts']))).toEqual([]);
  });

  test('reintroduced is refused, naming each file and the script that replaces it', async () => {
    const [finding, ...rest] = await rootBinFindings(await repo(['bin/check', 'bin/setup']));
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ROOT_BIN_REINTRODUCED');
    expect(finding?.cause).toContain('bin/check, bin/setup');
    expect(finding?.fix).toContain('git rm -r bin/');
    for (const command of Object.values(REPLACEMENTS)) expect(finding?.fix).toContain(command);
  });

  test('an empty bin/ directory is refused too: it is one file away', async () => {
    const root = await repo([]);
    await mkdir(join(root, 'bin'));
    expect((await rootBinFindings(root)).map((f) => f.code)).toEqual(['X_ROOT_BIN_REINTRODUCED']);
  });

  test('a bin file (not a directory) is refused', async () => {
    expect((await rootBinFindings(await repo(['bin']))).map((f) => f.code)).toEqual([
      'X_ROOT_BIN_REINTRODUCED',
    ]);
  });

  test('a nested bin/ — an app or a package — is not the root and is left alone', async () => {
    const root = await repo(['examples/dummy/bin/setup', 'packages/cli/bin/x']);
    expect(await rootBinFindings(root)).toEqual([]);
  });
});

test('the tree as committed has no root bin/', async () => {
  expect(await rootBinFindings(repoRoot())).toEqual([]);
});
