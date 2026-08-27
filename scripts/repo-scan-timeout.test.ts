// The rule that keeps `REPO_SCAN_TIMEOUT_MS` from being a convention six files never heard of.
// A `scripts/` test that reads the real tree contends with every other one under `--parallel`, so
// it runs on the repo-scan backstop; nothing was checking, and the six newest scanners sat on Bun's
// 5000ms default until a runtime 1.3x slower turned 21 of them red at once.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/**
 * The two legal FORMS, matched as code rather than as a token, and that distinction is the whole
 * rule. A first draft asked whether the source `includes('REPO_SCAN_TIMEOUT_MS')` and could not
 * fail: every enrolled file names the constant in the comment above the call, so deleting the call
 * and the import left the rule green — the same defect `checkErrorCodeDocs` shipped, where any
 * `X_*` in backticks anywhere on a page counted as documentation. Proved by mutation both ways.
 */
const DECLARES_BUDGET = [
  /setDefaultTimeout\(REPO_SCAN_TIMEOUT_MS\)/, // file-level: every test here scans
  /^\s*REPO_SCAN_TIMEOUT_MS,?\s*$/m, // per-test third argument, as Biome formats it
  /,\s*REPO_SCAN_TIMEOUT_MS\)/, // the same on one line
];

/**
 * `repoRoot()` is the marker, and it is the right one for the same reason the constant lives beside
 * it: **calling it is what makes a scan whole-repo.** A test that only builds a fixture in memory
 * never reaches for it, so this rule cannot fire on one — and a test that does reach for it is in
 * the class that contends, whether or not today's machine happens to be fast enough.
 */
const READS_THE_TREE = 'repoRoot()';

const scriptTests = (): readonly string[] =>
  [...new Bun.Glob('**/*.test.ts').scanSync({ cwd: join(repoRoot(), 'scripts') })].sort();

describe('unit · a scripts test that reads the tree declares the repo-scan budget', () => {
  test('every one of them names REPO_SCAN_TIMEOUT_MS', async () => {
    const missing: string[] = [];
    let reading = 0;
    for (const path of scriptTests()) {
      const source = await Bun.file(join(repoRoot(), 'scripts', path)).text();
      if (!source.includes(READS_THE_TREE)) continue;
      reading += 1;
      if (!DECLARES_BUDGET.some((form) => form.test(source))) missing.push(`scripts/${path}`);
    }
    // A glob matching nothing, or a marker no file uses, would pass this rule in silence — which is
    // exactly how the convention rotted in the first place.
    expect(reading).toBeGreaterThanOrEqual(50);
    expect(
      missing,
      "these read the real tree on Bun's 5000ms default — add `setDefaultTimeout(REPO_SCAN_TIMEOUT_MS)` after the imports, or pass REPO_SCAN_TIMEOUT_MS as the test's third argument",
    ).toEqual([]);
  });

  test('and the scan really read files, rather than agreeing with an empty list', () => {
    const found = scriptTests();
    expect(found.length).toBeGreaterThanOrEqual(50);
    expect(found).toContain('repo-scan-timeout.test.ts');
    // This file is its own first subject: it reads the tree, so it must satisfy its own rule.
    expect(found).toContain('lib/run.test.ts');
  });

  /**
   * `packages/` may not import `scripts/lib/run.ts` — a published package's suite must not reach
   * into the host monorepo — so three `@ultimat3/cli` tests that scan every installed package's
   * source carry the number as a LITERAL, each with a comment saying it mirrors this constant. The
   * comment was the only thing holding it: they read `30_000` while the constant was `90_000`, a
   * whole factor below what they claimed, and one of them was the last red in the Bun 1.3 run.
   * A mirror nothing compares is a wish.
   */
  test('the packages-side literals that claim to mirror the budget actually carry it', async () => {
    const mirrors = [
      'packages/cli/src/cmd-mcp.test.ts',
      'packages/cli/src/error-catalog.test.ts',
      'packages/cli/src/cmd-errors.test.ts',
    ];
    const literal = `}, ${String(REPO_SCAN_TIMEOUT_MS / 1000)}_000);`;
    for (const path of mirrors) {
      const source = await Bun.file(join(repoRoot(), path)).text();
      // Each names the constant, so a reader knows which number moved; and carries its value.
      expect(source, `${path} no longer names REPO_SCAN_TIMEOUT_MS`).toContain(
        'REPO_SCAN_TIMEOUT_MS',
      );
      expect(source, `${path} does not carry ${literal}`).toContain(literal);
    }
  });

  test('the budget is a real number of milliseconds, generous enough to be a backstop', () => {
    expect(REPO_SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(Number.isInteger(REPO_SCAN_TIMEOUT_MS)).toBe(true);
  });
});
