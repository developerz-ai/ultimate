#!/usr/bin/env bun
// Enforce, as a gate step, that a `fix:` a TEST writes or asserts is a command this build can run.
// The same question `x verify`'s `errors` step asks of shipped source and `scripts/doc-fixes.ts`
// asks of the error reference, asked of test sources for the first time.
//
// The gap this closes: `checkErrorFixes` reads `src/` and skips tests, so a fixture error, a
// helper that builds one, and an assertion pinning a fix string were all unchecked — and the repo
// has shipped a `fix:` naming a command that does not exist more than once (`x schema show`,
// `x logs tail`). A test is where the next one is written down and copied from.
//
// A citation counts only when the code EVALUATES it (`scripts/lib/source-strings.ts`): a command
// inside a comment is prose about a command, and one inside another string is a fixture's source
// text — which is what `packages/cli/src/error-contract.test.ts` writes to disk on purpose, seven
// times, to prove this very rule bites. That is the exemption, and it is a property of the code
// rather than a list of filenames nobody re-reads.
//
//   bun run scripts/test-fix-citations.ts [--json]
//   bun run scripts/test-fix-citations.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { type CommandCatalog, citedCommandProblem, loadCommandCatalog } from '@ultimat3/cli';
import { flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { sourceStrings } from './lib/source-strings';
import { PINS_FILE, TEST_FIX_PINS, testFixPinnedFor } from './lib/test-fix-pins';

const SCRIPT = 'test-fix-citations';

export const TEST_GLOBS: readonly string[] = [
  'packages/*/src/**/*.test.ts',
  'packages/*/src/**/*.test.tsx',
  'scripts/**/*.test.ts',
];

/** The literal is a `fix:` property value. */
const PROPERTY = /(?:^|[^\w$.])fix\s*:\s*$/;
/**
 * The literal is what a `fix` assertion compares against — and NOT what a negated one refuses.
 * `expect(fix).not.toContain('x logs')` is a test enforcing this very rule, three times in this
 * repo; reading it as a citation reports a finding on the assertion that prevents the finding.
 */
const ASSERTION = /\.fix\b(?:(?!\.not\b)[\s\S])*\.(?:toBe|toContain|toEqual|toMatch)\(\s*$/;

export interface TestFixCitation {
  readonly path: string;
  readonly line: number;
  readonly fix: string;
}

/**
 * Every `fix:` a test file evaluates, whether it declares one or asserts one. Pure over the text,
 * so the negative cases are fixtures rather than edits to tests other people are rewriting.
 */
export function scanTestFixes(path: string, source: string): readonly TestFixCitation[] {
  const out: TestFixCitation[] = [];
  for (const literal of sourceStrings(source)) {
    if (!literal.value.startsWith('x ')) continue;
    if (!PROPERTY.test(literal.prefix) && !ASSERTION.test(literal.prefix)) continue;
    out.push({ path, line: literal.line, fix: literal.value });
  }
  return out;
}

/**
 * `over` is the hazard: a package citing more unrunnable commands than it is pinned at, which is
 * also how a package pinned at 0 reports its first. `stale` is the ratchet's own hygiene — a pin
 * nothing needs any more. `unscanned` is the false green: a glob matching no test file would
 * otherwise read as "every asserted fix runs".
 */
export type TestFixGapKind = 'over' | 'stale' | 'unscanned';

export interface TestFixGap {
  readonly kind: TestFixGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: { readonly at: string; readonly fix: string; readonly problem: string };
}

export interface TestFixInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly catalog: CommandCatalog;
  readonly pins: Readonly<Record<string, number>>;
}

/** `packages/db/src/x.test.ts` -> `db`; anything else -> its first path segment. */
export const packageOf = (path: string): string =>
  path.startsWith('packages/') ? (path.split('/')[1] ?? path) : (path.split('/')[0] ?? path);

export function checkTestFixes(input: TestFixInput): readonly TestFixGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = new Map<string, TestFixGap['first'][]>();
  for (const file of input.files) {
    for (const citation of scanTestFixes(file.path, file.text)) {
      const problem = citedCommandProblem(citation.fix, input.catalog);
      if (problem === undefined) continue;
      const pkg = packageOf(citation.path);
      const list = found.get(pkg) ?? [];
      list.push({ at: `${citation.path}:${String(citation.line)}`, fix: citation.fix, problem });
      found.set(pkg, list);
    }
  }
  const gaps: TestFixGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = testFixPinnedFor(pkg, input.pins);
    if (hits.length > pinned) {
      gaps.push({
        kind: 'over',
        pkg,
        found: hits.length,
        pinned,
        ...(hits[0] === undefined ? {} : { first: hits[0] }),
      });
      continue;
    }
    if (hits.length < pinned) gaps.push({ kind: 'stale', pkg, found: hits.length, pinned });
  }
  return gaps.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
}

const overFinding = (gap: TestFixGap): Finding => ({
  code: 'X_TEST_FIX_UNRUNNABLE',
  cause: `${gap.pkg} has ${String(gap.found)} test fix line(s) citing a command this build cannot run and is pinned at ${String(gap.pinned)} — ${gap.first?.at ?? ''} writes "${gap.first?.fix ?? ''}", which ${gap.first?.problem ?? ''}`,
  fix: `rewrite the fix at ${gap.first?.at ?? gap.pkg} as an invocation this build ships; \`x help --json\` lists every command, subcommand and flag`,
  at: gap.first?.at ?? gap.pkg,
});

const staleFinding = (gap: TestFixGap): Finding => ({
  code: 'X_TEST_FIX_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unrunnable test fix line(s) and now has ${String(gap.found)} — the ratchet may only fall, so a pin nobody lowers is one nobody reads`,
  fix: `bun run scripts/${SCRIPT}.ts --unpin ${gap.pkg}`,
  at: PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_FIX_UNSCANNED',
  cause: 'no test file matched, so this rule reported green over a file set it never read',
  fix: `check TEST_GLOBS in scripts/${SCRIPT}.ts still matches this repo's test layout`,
  at: `scripts/${SCRIPT}.ts`,
});

const FINDINGS: Readonly<Record<TestFixGapKind, (gap: TestFixGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const testFixFindingFor = (gap: TestFixGap): Finding => FINDINGS[gap.kind](gap);

export async function readTestSources(
  root: string,
): Promise<readonly { path: string; text: string }[]> {
  const seen = new Map<string, { path: string; text: string }>();
  for (const glob of TEST_GLOBS) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root, absolute: false })) {
      if (seen.has(path)) continue;
      seen.set(path, { path, text: await Bun.file(`${root}/${path}`).text() });
    }
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const testFixGaps = async (root: string): Promise<readonly TestFixGap[]> =>
  checkTestFixes({
    files: await readTestSources(root),
    catalog: await loadCommandCatalog(),
    pins: TEST_FIX_PINS,
  });

/** What this repo contributes to `x verify`'s `errors` step. */
export const testFixFindings = async (root: string): Promise<readonly Finding[]> =>
  (await testFixGaps(root)).map(testFixFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const gaps = await testFixGaps(root);
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const { applyTestFixUnpin } = await import('./lib/test-fix-pins');
    const written = await applyTestFixUnpin(root, unpin, gaps);
    report(
      {
        ok: written.length > 0,
        script: SCRIPT,
        summary:
          written.length > 0
            ? `lowered ${written.join(', ')} in ${PINS_FILE}`
            : `nothing to lower: ${unpin.join(', ')} is already at what is measured`,
        findings: [],
      },
      args.json,
    );
    process.exit(written.length > 0 ? 0 : 1);
  }
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? `every fix: a test evaluates cites a command this build can run`
          : `${gaps.length} package(s) off the unrunnable-test-fix ratchet`,
      findings: gaps.map(testFixFindingFor),
    },
    args.json,
  );
}
