// Every temp directory the framework's own tests and fixtures make is removed by the file that made
// it (#738): a suite that leaves its trees in the temp root is the same leftover `x clean` exists to
// sweep in an app, and the framework holds itself to the rule it ships. This file IS the build
// error — the gate's `unit` step runs every `scripts/**/*.test.ts`.
//
// The rule is lexical, and deliberately so: a file that calls `mkdtemp`/`mkdtempSync` also calls a
// remove (`rm`, `rmSync`, `rmdir`, `rmdirSync`). Where the directory is handed to another owner (a
// fixture that returns it), that owner's file is the one that must remove it — which is the case
// `cmd-jobs-fixture.ts` was the counterexample to.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const ROOTS = ['packages', 'scripts', 'examples', 'dummy'];
const SKIP = /(^|\/)(node_modules|dist|\.x)\//;
const MAKES = /\bmkdtemp(Sync)?\(/;
const REMOVES = /\b(rm|rmSync|rmdir|rmdirSync)\(/;

/** Repo-relative paths of every `.ts` file that makes a temp directory and never removes one. */
async function leakingFiles(root: string): Promise<readonly string[]> {
  const leaking: string[] = [];
  for (const dir of ROOTS) {
    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: join(root, dir) })) {
      const path = `${dir}/${file}`;
      if (SKIP.test(path) || path === 'scripts/temp-dir-cleanup.test.ts') continue;
      const source = await Bun.file(join(root, path)).text();
      if (MAKES.test(source) && !REMOVES.test(source)) leaking.push(path);
    }
  }
  return leaking.sort();
}

describe('temp directories', () => {
  test(
    'every file that makes one removes what it made',
    async () => {
      expect(await leakingFiles(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
