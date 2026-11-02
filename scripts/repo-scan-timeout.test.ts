// The rule that keeps `REPO_SCAN_TIMEOUT_MS` from being a convention six files never heard of.
// A `scripts/` test that reads the real tree contends with every other one under `--parallel`, so
// it runs on the repo-scan backstop; nothing was checking, and the six newest scanners sat on Bun's
// 5000ms default until a runtime 1.3x slower turned 21 of them red at once — a gap smaller than
// what one noisy free runner adds, so this was never really about the Bun trial that exposed it.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
// why: the mask is how the rule reads code — a mention in prose or in a string is not a call.
import { maskLiterals } from '../packages/core/src/source-mask';
import { CLOSERS, OPENERS } from './lib/rendered-operands';
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
 * the class that contends, whether or not today's machine happens to be fast enough. Asked of the
 * mask, never the raw text: prose that QUOTES the call — a header saying "no repoRoot() here" —
 * is not a call, and counting one branded a fixture-only test a tree-reader.
 */
const READS_THE_TREE = 'repoRoot()';

const scriptTests = (): readonly string[] =>
  [...new Bun.Glob('**/*.test.ts').scanSync({ cwd: join(repoRoot(), 'scripts') })].sort();

/**
 * The mirror's own constant, matched in the MASK and not in the raw text.
 *
 * The raw text accepts a declaration that only exists in a COMMENT: `const REPO_SCAN_MS =
 * 30_000; // const REPO_SCAN_MS = 180_000;` carries the budget as text and runs every repo scan
 * under 30 seconds — a sixth of the budget the mirror claims — while the USE check below still
 * passes, because the tests pass the constant and the constant is the wrong number.
 * `maskLiterals` blanks a comment to spaces, so a declaration that is only quoted is no
 * declaration at all.
 */
const declaresBudget = (source: string): boolean =>
  maskLiterals(source).includes(`const REPO_SCAN_MS = ${String(REPO_SCAN_TIMEOUT_MS / 1000)}_000;`);

/**
 * One `test(…)` call: the body it runs, and the third argument it passes.
 *
 * The third argument is where a test declares its own timeout — the budget, when it has one.
 */
interface TestCall {
  readonly body: string;
  readonly third: string | undefined;
}

/**
 * A call's arguments, split at the commas that sit at its own depth — or `undefined` when the
 * call never closes.
 */
const callArguments = (masked: string, open: number): readonly string[] | undefined => {
  const parts: string[] = [];
  let depth = 1; // the call's own bracket
  let start = open + 1;
  for (let i = open + 1; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      depth -= 1;
      if (depth === 0) {
        parts.push(masked.slice(start, i));
        return parts;
      }
    } else if (ch === ',' && depth === 1) {
      parts.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  return undefined;
};

/**
 * Every `test(…)` call in a file, with the body it runs and the third argument it passes.
 *
 * Read off the MASKED source: a call's shape is code and the prose around it is not, so a
 * `test(` inside a string is not a call, and a `)` inside a string does not close an argument
 * early.
 */
const testCalls = (source: string): readonly TestCall[] => {
  const masked = maskLiterals(source);
  const calls: TestCall[] = [];
  for (const match of masked.matchAll(/(?<![.\w$])test\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(masked, open);
    if (args === undefined) continue;
    const third = args[2]?.trim();
    calls.push({ body: args[1] ?? '', third: third === '' ? undefined : third });
  }
  return calls;
};

/**
 * The calls that make a test read the repo: the ones that walk every installed package's
 * source, directly or through the helper that does it.
 */
const SCANS_THE_REPO: readonly string[] = [
  'loadCodeFixes(',
  'loadErrorCatalog(',
  'registeredErrorCodes(',
  'unindexedCode(',
];

describe('unit · a scripts test that reads the tree declares the repo-scan budget', () => {
  test('every one of them names REPO_SCAN_TIMEOUT_MS', async () => {
    const missing: string[] = [];
    let reading = 0;
    for (const path of scriptTests()) {
      const source = await Bun.file(join(repoRoot(), 'scripts', path)).text();
      // The mask, not the raw text: a comment or a string quoting `repoRoot()` is not a call, and
      // counting one reported a fixture-only test as a tree-reader.
      const code = maskLiterals(source);
      if (!code.includes(READS_THE_TREE)) continue;
      reading += 1;
      if (!DECLARES_BUDGET.some((form) => form.test(code))) missing.push(`scripts/${path}`);
    }
    // A glob matching nothing, or a marker no file uses, would pass this rule in silence — which is
    // exactly how the convention rotted in the first place.
    expect(reading).toBeGreaterThanOrEqual(50);
    expect(
      missing,
      "these read the real tree on Bun's 5000ms default — add `setDefaultTimeout(REPO_SCAN_TIMEOUT_MS)` after the imports, or pass REPO_SCAN_TIMEOUT_MS as the test's third argument",
    ).toEqual([]);
  });

  test('a mention in prose or in a string is not a call — the marker is asked of the mask', () => {
    // health.ts.test.ts's own header says "no repoRoot() here, no real tree", and the rule heard a
    // call. The mask blanks a comment and a literal's text; a real call survives it.
    expect(maskLiterals('// no repoRoot() here, no real tree\nexport {};\n')).not.toContain(
      READS_THE_TREE,
    );
    expect(maskLiterals("const s = 'repoRoot()';\n")).not.toContain(READS_THE_TREE);
    expect(maskLiterals('const root = repoRoot();\n')).toContain(READS_THE_TREE);
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
   * into the host monorepo — so the `@ultimat3/cli` tests that scan every installed package's
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
      // The dev host's two halves: `createDevMcpServer` awaits `loadCodeFixes()` on boot, and the
      // errors.explain suite awaits it directly. Both read every installed package's source.
      'packages/cli/src/mcp-host.test.ts',
      'packages/cli/src/mcp-host-tools.test.ts',
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

  /**
   * The same rule in the one spelling this package uses elsewhere: a file that hands the budget to
   * several tests through a constant of its own carries it in THAT constant, and the constant is
   * what the tests pass — so it is what has to match.
   */
  test('a mirror that hands the budget over through a constant of its own carries it too', async () => {
    const path = 'packages/cli/src/error-fixes.test.ts';
    const source = await Bun.file(join(repoRoot(), path)).text();
    expect(source, `${path} no longer names REPO_SCAN_TIMEOUT_MS`).toContain(
      'REPO_SCAN_TIMEOUT_MS',
    );
    expect(declaresBudget(source), `${path} does not carry the budget`).toBe(true);
  });

  /**
   * THE REGRESSION DIRECTION: the declaration is matched in the MASK, so a budget that only
   * appears in a comment is not a declaration. Match the raw text and this mutation goes green
   * again — the file carries the budget as TEXT and every repo scan in it runs under 30 seconds.
   */
  test('a budget quoted in a comment is not a declaration', () => {
    const budget = String(REPO_SCAN_TIMEOUT_MS / 1000);
    const mutated = [
      `const REPO_SCAN_MS = 30_000; // const REPO_SCAN_MS = ${budget}_000;`,
      "test('scans the repo', async () => { await loadCodeFixes(); }, REPO_SCAN_MS);",
    ].join('\n');
    expect(declaresBudget(mutated)).toBe(false);
    // The USE still passes on the mutation — the tests pass the constant, and the constant is
    // the wrong number. That is why the DECLARATION has to be read, not the use.
    expect(testCalls(mutated)[0]?.third).toBe('REPO_SCAN_MS');
  });

  /**
   * The DECLARATION is only half of a mirror: replace every repo-scanning test's third argument
   * with a literal and `const REPO_SCAN_MS = 180_000;` still reads the same, while the budget
   * those tests run under is whatever someone typed — the "a mirror nothing compares is a wish"
   * defect this file's own header names. So the USE is asserted too: the constant is what the
   * tests pass, and it is what has to match.
   */
  test('and the repo-scanning tests there pass that constant, not a literal', async () => {
    const path = 'packages/cli/src/error-fixes.test.ts';
    const source = await Bun.file(join(repoRoot(), path)).text();
    const calls = testCalls(source);
    const scanning = calls.filter((call) =>
      SCANS_THE_REPO.some((marker) => call.body.includes(marker)),
    );
    // A floor, not an equality: that file's own count is its business, and a test added there
    // later must not turn this red for no reason. What the floor refuses is a scan that finds
    // NOTHING and passes in silence.
    expect(scanning.length).toBeGreaterThanOrEqual(6);
    expect(
      scanning
        .filter((call) => call.third !== 'REPO_SCAN_MS')
        .map((call) => call.third ?? 'no third argument'),
      `${path}: a test that reads the repo passes REPO_SCAN_MS as its third argument`,
    ).toEqual([]);
  });

  test('the budget is a real number of milliseconds, generous enough to be a backstop', () => {
    expect(REPO_SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(Number.isInteger(REPO_SCAN_TIMEOUT_MS)).toBe(true);
  });
});
