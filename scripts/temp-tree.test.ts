// The unowned tree first — a bare `mkdtemp` in a file that runs git, or inside the checkout — then
// what must never be one: a temp-root tree with no git, git in prose, the helper's file, a shipped module. Then the ratchet's
// answers, and the tree itself: this file is the build error the gate's `unit` step runs.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkTempTrees, scanTempTrees, tempTreeFindingFor, tempTreeGaps } from './temp-tree';

const TEST = 'packages/x/src/a.test.ts';
const scan = (lines: readonly string[], path = TEST) => scanTempTrees(path, lines.join('\n'));

const MAKE = "const dir = mkdtempSync(join(tmpdir(), 'x-'));";

describe('scanTempTrees', () => {
  test('a bare mkdtemp in a file that spawns git is a site, by the mkdtemp’s line', () => {
    expect(scan([MAKE, "await exec(['git', 'commit', '-qm', 'one'], { cwd: dir });"])).toEqual([
      { path: TEST, line: 1, form: 'git' },
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

  test('a tree made off the module’s own directory is in-repo, git or no git', () => {
    const found = scan([
      "const a = mkdtempSync(join(import.meta.dir, '..', '.mcp-runtime-fixture-'));",
      "const b = await mkdtemp(join(import.meta.dirname, '.e2e-locale-'));",
      "const c = mkdtempSync(join(__dirname, 'x-'));",
      "const d = mkdtempSync(join(tmpdir(), 'x-'));",
    ]);
    expect(found.map((site) => [site.line, site.form])).toEqual([
      [1, 'in-repo'],
      [2, 'in-repo'],
      [3, 'in-repo'],
    ]);
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
    const [gap, ...rest] = checkTempTrees({ files, pins: {} });
    expect(rest).toEqual([]);
    if (gap === undefined) return expect.unreachable('an unowned tree over a zero pin is a gap');
    const finding = tempTreeFindingFor(gap);
    expect(finding.code).toBe('X_TEST_TEMP_TREE_UNOWNED');
    expect(finding.cause).toContain(`${TEST}:1 (git)`);
    expect(finding.fix.startsWith("tempTree('<prefix>-', { inPackage:")).toBe(true);
  });

  test('a pin above what the tree holds is stale, and the fix lowers it', () => {
    const [gap] = checkTempTrees({ files, pins: { x: 2 } });
    if (gap === undefined) return expect.unreachable('a pin above the tree is a gap');
    const finding = tempTreeFindingFor(gap);
    expect(finding.code).toBe('X_TEST_TEMP_TREE_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/temp-tree.ts --unpin x');
  });

  test('a pin the tree meets exactly is no gap; nothing read is never a clean tree', () => {
    expect(checkTempTrees({ files, pins: { x: 1 } })).toEqual([]);
    expect(checkTempTrees({ files: [], pins: {} })[0]?.kind).toBe('unscanned');
  });
});

test(
  'the tree holds no unowned temp tree beside git above its pins',
  async () => {
    expect((await tempTreeGaps(repoRoot())).map(tempTreeFindingFor)).toEqual([]);
  },
  REPO_SCAN_TIMEOUT_MS,
);
