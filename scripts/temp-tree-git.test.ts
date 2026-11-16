// The unowned tree first — a bare `mkdtemp` in a file that runs git — then what must never be one:
// a tree with no git, git in prose, the helper's own file, a shipped module. Then the ratchet's
// answers, and the tree itself: this file is the build error the gate's `unit` step runs.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkTempTreeGit,
  scanTempTreeGit,
  tempTreeGitFindingFor,
  tempTreeGitGaps,
} from './temp-tree-git';

const TEST = 'packages/x/src/a.test.ts';
const scan = (lines: readonly string[], path = TEST) => scanTempTreeGit(path, lines.join('\n'));

const MAKE = "const dir = mkdtempSync(join(tmpdir(), 'x-'));";

describe('scanTempTreeGit', () => {
  test('a bare mkdtemp in a file that spawns git is a site, by the mkdtemp’s line', () => {
    expect(scan([MAKE, "await exec(['git', 'commit', '-qm', 'one'], { cwd: dir });"])).toEqual([
      { path: TEST, line: 1 },
    ]);
  });

  test('every spelling of git, spawned', () => {
    const argv = [
      'const dir = await mkdtemp(prefix);',
      'Bun.spawn([',
      "  'git',",
      "  'init',",
      ']);',
    ];
    expect(scan(argv)).toHaveLength(1);
    expect(scan([MAKE, "await git(dir, 'init', '-q');"])).toHaveLength(1);
    expect(scan([MAKE, 'await sh(`git init -q && git add -A`);'])).toHaveLength(1);
    expect(scan([MAKE, 'await Bun.$`git status`;'])).toHaveLength(1);
    expect(scan([MAKE, MAKE, "Bun.spawnSync(['git', 'init'], { cwd: dir });"])).toHaveLength(2);
  });

  test('no git, git in prose, or git in a fix string is not a site', () => {
    expect(scan([MAKE, 'await Bun.write(join(dir, "a"), "x");'])).toEqual([]);
    expect(scan([MAKE, "// ['git', 'commit'] used to run here"])).toEqual([]);
    expect(scan([MAKE, "expect(fix).toBe('git add -A && git commit -m x');"])).toEqual([]);
    // A fake runner's builder takes a cwd and a LIST of changed files: it spawns nothing.
    expect(scan([MAKE, "const { runner } = git(root, ['docs/a.md']);"])).toEqual([]);
  });

  test('the helper’s own home and this rule are exempt; a shipped module is out of scope', () => {
    const lines = [MAKE, "Bun.spawn(['git', 'init']);"];
    expect(scan(lines, 'packages/testing/src/temp-tree.ts')).toEqual([]);
    expect(scan(lines, 'packages/cli/src/cmd-new.ts')).toEqual([]);
    expect(scan(lines, 'packages/cli/src/fix-truth-fixture.ts')).toHaveLength(1);
    expect(scan(lines, 'packages/cli/e2e/upgrade.e2e.test.ts')).toHaveLength(1);
    expect(scan(lines, 'scripts/upgrade-fixtures-run.ts')).toHaveLength(1);
  });
});

describe('the ratchet', () => {
  const files = [{ path: TEST, text: [MAKE, "Bun.spawn(['git', 'init']);"].join('\n') }];

  test('a site over its package’s pin is X_TEST_TEMP_TREE_UNOWNED, naming the site and the helper', () => {
    const [gap, ...rest] = checkTempTreeGit({ files, pins: {} });
    expect(rest).toEqual([]);
    if (gap === undefined) return expect.unreachable('an unowned tree over a zero pin is a gap');
    const finding = tempTreeGitFindingFor(gap);
    expect(finding.code).toBe('X_TEST_TEMP_TREE_UNOWNED');
    expect(finding.cause).toContain(`${TEST}:1`);
    expect(finding.fix.startsWith("tempTree('<prefix>-')")).toBe(true);
  });

  test('a pin above what the tree holds is stale, and the fix lowers it', () => {
    const [gap] = checkTempTreeGit({ files, pins: { x: 2 } });
    if (gap === undefined) return expect.unreachable('a pin above the tree is a gap');
    const finding = tempTreeGitFindingFor(gap);
    expect(finding.code).toBe('X_TEST_TEMP_TREE_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/temp-tree-git.ts --unpin x');
  });

  test('a pin the tree meets exactly is no gap; nothing read is never a clean tree', () => {
    expect(checkTempTreeGit({ files, pins: { x: 1 } })).toEqual([]);
    expect(checkTempTreeGit({ files: [], pins: {} })[0]?.kind).toBe('unscanned');
  });
});

test(
  'the tree holds no unowned temp tree beside git above its pins',
  async () => {
    expect((await tempTreeGitGaps(repoRoot())).map(tempTreeGitFindingFor)).toEqual([]);
  },
  REPO_SCAN_TIMEOUT_MS,
);
