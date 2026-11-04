// The package directory list, derived from disk: a package added and not listed is a package
// nothing typechecks. The tree is read here by a different road than the script's — a directory
// listing and a stat, never the glob it globs with — so the list is checked, not restated.
//
// The command is pinned here too: it answered from an `import.meta.main` block, so every line of
// it counted as uncovered — a command nothing could exercise was a command nothing had proved.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no directory listing of its own; `readdirSync` is how a folder is read.
import { existsSync, readdirSync } from 'node:fs';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { listPackageDirs, packageDirs } from './list-package-dirs';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unit · the package directory list is the tree on disk', () => {
  test('every packages/* with a src/ is listed, sorted, and nothing else is', () => {
    const root = repoRoot();
    const expected = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'src')),
      )
      .map((entry) => entry.name)
      .sort();

    const dirs = packageDirs(root);

    expect(dirs).toEqual(expected);
    // Not vacuous: a list that matched nothing would agree with an empty tree.
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain('core');
  });
});

describe('unit · the command answers with the directories it lists', () => {
  test('ok, the count in the summary, and the same directories as data', () => {
    const root = repoRoot();
    const dirs = packageDirs(root);

    const result = listPackageDirs(root);

    expect(result.ok).toBe(true);
    expect(result.script).toBe('list-package-dirs');
    // The count is the list's own, not a constant: a summary that drifted from the data would
    // still read true.
    expect(result.summary).toBe(`${dirs.length} package directories`);
    expect(result.findings).toEqual([]);
    expect(result.data).toEqual(dirs);
  });
});
