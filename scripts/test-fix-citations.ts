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
import { CORPUS_PATTERNS, corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { sourceStrings } from './lib/source-strings';
import { PINS_FILE, TEST_FIX_PINS } from './lib/test-fix-pins';

const SCRIPT = 'test-fix-citations';
const EXPLAIN = 'bun run scripts/test-fix-citations.ts --explain --json lists every one';

/** What the `tests` corpus scope reads, re-exported under the name its callers already use. */
export const TEST_GLOBS: readonly string[] = CORPUS_PATTERNS.tests;

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

/** One unrunnable citation: where, what it says, and why the registry refuses it. */
export interface TestFixSite {
  readonly path: string;
  readonly at: string;
  readonly fix: string;
  readonly problem: string;
}

export type TestFixGap = RatchetGap<TestFixSite>;

export interface TestFixInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly catalog: CommandCatalog;
  readonly pins: PinTable;
}

const testFixSites = (input: Omit<TestFixInput, 'pins'>): readonly TestFixSite[] =>
  input.files.flatMap((file) =>
    scanTestFixes(file.path, file.text).flatMap((citation) => {
      const problem = citedCommandProblem(citation.fix, input.catalog);
      if (problem === undefined) return [];
      const at = `${citation.path}:${String(citation.line)}`;
      return [{ path: citation.path, at, fix: citation.fix, problem }];
    }),
  );

/** `over` is the hazard; `stale` a pin nothing needs; `unscanned` a glob that matched nothing. */
export const checkTestFixes = (input: TestFixInput): readonly TestFixGap[] =>
  ratchetGaps(testFixSites(input), input.pins, input.files.length > 0);

const said = (site: TestFixSite): string => `${site.at} ("${site.fix}", which ${site.problem})`;

/** Every citation, new ones first — the package's first is usually one its pin already allows. */
const overFinding = (gap: TestFixGap): Finding => ({
  code: 'X_TEST_FIX_UNRUNNABLE',
  cause: `${gap.pkg} has ${String(gap.found)} test fix line(s) citing a command this build cannot run and is pinned at ${String(gap.pinned)} — ${siteList(gap, said, EXPLAIN)}`,
  fix: `rewrite the fix at ${siteTarget(gap, (site) => site.at)} as an invocation this build ships; \`x help --json\` lists every command, subcommand and flag`,
  at: leadSite(gap)?.at ?? gap.pkg,
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
  // Literal path for the same reason release-facts.ts records: an interpolated `${SCRIPT}`
  // renders as `scripts/<value>.ts` to the static fix-line contract, which then names no file.
  fix: "edit TEST_GLOBS in scripts/test-fix-citations.ts so it matches this repo's test layout",
  at: `scripts/${SCRIPT}.ts`,
});

export const testFixFindingFor = (gap: TestFixGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

/** The `tests` corpus scope — `TEST_GLOBS`' files, read once per process for every rule on them. */
export async function readTestSources(
  root: string,
): Promise<readonly { path: string; text: string }[]> {
  return (await corpus(root, 'tests')).map((file) => ({ path: file.path, text: file.source }));
}

/** The single-file scan against one catalog: what tells a new citation from one the base held. */
const probeFor = (catalog: CommandCatalog): SiteProbe<TestFixSite> => ({
  rescan: (path, text) => testFixSites({ files: [{ path, text }], catalog }),
  line: (site) => Number(site.at.slice(site.at.lastIndexOf(':') + 1)),
});

export const testFixGaps = async (root: string): Promise<readonly TestFixGap[]> => {
  const catalog = await loadCommandCatalog();
  const gaps = checkTestFixes({ files: await readTestSources(root), catalog, pins: TEST_FIX_PINS });
  return newSitesFirst(root, gaps, probeFor(catalog));
};

/** What this repo contributes to `x verify`'s `errors` step. */
export const testFixFindings = async (root: string): Promise<readonly Finding[]> =>
  (await testFixGaps(root)).map(testFixFindingFor);

const treeSites = async (root: string): Promise<readonly TestFixSite[]> =>
  testFixSites({ files: await readTestSources(root), catalog: await loadCommandCatalog() });

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: PINS_FILE,
    pins: TEST_FIX_PINS,
    sites: treeSites,
    findingFor: testFixFindingFor,
    probe: probeFor(await loadCommandCatalog()),
    clean: 'every fix: a test evaluates cites a command this build can run',
  });
}
