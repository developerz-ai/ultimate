#!/usr/bin/env bun
// Enforce, as a gate step, that a test does not report ITS OWN verdict by throwing a bare `Error`,
// and that shipped source throws no bare builtin Error class at all.
//
// `CLAUDE.md` says never throw a bare `Error`, and `checkErrorFixes` opens with
// `if (isTest(path) || isGenerated(path)) continue` — so in test files the rule was prose only,
// which axiom 3 says is no rule at all. 422 `new Error(` sites were sitting under a green gate;
// the issue that opened this (#132) counted 295, and the growth is its own argument.
//
// THE SOURCE SCOPE, the half that had no table: two bare builtin throws sat in `@ultimat3/ai`'s
// two wire readers, where a `SyntaxError` was thrown and caught by the very catch that re-threw it
// as a coded transport error. A fixture double that throws AT the subject is shipped source too,
// and no shape tells the two apart, so the distinction is written down —
// `scripts/lib/source-bare-error-exemptions.ts`, one row per intentional site, and a row that
// matches no site is a finding of its own.
//
//   bun run scripts/test-bare-error.ts [--json]
//   bun run scripts/test-bare-error.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

// The leaf module, never the `@ultimat3/core` barrel: a guard must not link the whole tree.
import { singleLine } from '../packages/core/src/error-render';
import { maskLiterals } from '../packages/core/src/source-mask';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { packageOf, ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import {
  SOURCE_BARE_ERROR_EXEMPTIONS,
  SOURCE_BARE_ERROR_EXEMPTIONS_FILE,
  type SourceBareErrorExemption,
} from './lib/source-bare-error-exemptions';
import { isTestPath } from './lib/source-scan';
import { BARE_ERROR_PINS, PINS_FILE } from './lib/test-bare-error-pins';
import { readTestSources } from './test-fix-citations';

const SCRIPT = 'test-bare-error';
const EXPLAIN = 'bun run scripts/test-bare-error.ts --explain --json lists every one';

/**
 * `throw` is the whole rule, and it is what makes the two populations separable — which #132 said
 * grep could not do. It is right that `new Error` alone cannot be judged: the difference is whether
 * the error is the test's INPUT or its VERDICT, and `throw` is exactly where that shows.
 *
 * An input is a foreign error handed to the code under test, and is **not reported at all** —
 * `Promise.reject(new Error('redis is down'))`, `render(new Error('the driver went away'))`,
 * `Object.assign(new Error('denied'), { code, cause, fix })`. 159 such sites, and
 * `packages/realtime/CLAUDE.md` already states the carve-out as settled: *"A test fixture standing
 * in for a FOREIGN error extends `Error` on purpose… The rule governs what this package throws,
 * never what a test hands it."* Rebuilding those as `UltimateError` would change what the
 * surrounding tests prove.
 *
 * A verdict is the test itself saying the subject misbehaved — `throw new Error('expected a
 * refusal, and nothing was thrown')` — and `expect.unreachable` is this repo's idiom for it
 * (10+ uses in `packages/realtime/src/`): it reports at the assertion with the value that actually
 * arrived, and its `never` return narrows the variable so no cast is needed.
 *
 * `new` is optional: `throw Error('x')` constructs the same bare `Error`, and a rule that needed
 * the keyword was a rule one deleted word could step around. Every builtin `Error` class is the
 * same bare verdict — no code, no cause, nothing to run — so `throw new TypeError(…)` and its five
 * siblings are one rule, the list the shipped `bare-error` guard reads too (K19). Since plan 101
 * sweep 11 the class may be reached through `globalThis.`, and a thrown STRING or template is the
 * same verdict with even less on it — no stack, no code, nothing to run.
 */
const THROWN =
  /\bthrow\s+(?:(?:new\s+)?(?:globalThis\s*\.\s*)?(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError)\s*\(|['"`])/g;

/** The honest limit, stated rather than guessed at — see `bareErrorFindingFor`'s cause. */
export interface BareErrorSite {
  readonly path: string;
  readonly line: number;
}

export function scanBareErrorThrows(path: string, source: string): readonly BareErrorSite[] {
  // A COMMENT quoting the shape is prose ABOUT a throw, never one — and reading it as a throw is
  // this rule punishing the only sentence that can explain it. It fired: a `packages/db` test
  // whose header read "reads a literal `throw new Error(…)` as a verdict wherever it appears" took
  // that package 24 -> 25 with no throw in the file, and the comment was reworded to clear a gate.
  // `dead-docs-host.ts` already carries the same carve-out in the same words — a comment naming
  // the banned thing as the thing that was removed cannot commit it. `maskLiterals` blanks a
  // comment to spaces and preserves every offset, so the string exemption below still lines up.
  //
  // The mask is `maskLiterals`, not comments alone: it blanks a string's CONTENTS and a REGEX
  // body's too, and a regex holds quotes that delimit nothing (`/class="([^"]*)"/`). The reader
  // that took the first of those for a string opener swallowed the rest of the file and hid a
  // real bare throw behind it — `packages/render/src/navigation-dom-fixture.ts`, whose fake
  // DOMParser threw a builtin `TypeError` in shipped source that no rule could see.
  const code = maskLiterals(source);
  const out: BareErrorSite[] = [];
  for (const match of code.matchAll(THROWN)) {
    const at = match.index ?? 0;
    out.push({ path, line: source.slice(0, at).split('\n').length });
  }
  return out;
}

export type BareErrorGap = RatchetGap<BareErrorSite>;

export interface BareErrorInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}

export const checkBareErrors = (input: BareErrorInput): readonly BareErrorGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanBareErrorThrows(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: BareErrorSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

/**
 * A value as a DIAGNOSTIC shows it: every control character escaped.
 *
 * WHY: a path may hold a newline — a file named `a\nb.ts` — and the `fix` line is a shell
 * comment, so `# … replace the throw at scripts/a` ends that comment at the newline and the
 * rest of the path runs as a COMMAND when the diagnostic is pasted. The same is true of a
 * package name in an `--unpin` command. `singleLine` is core's one escape for exactly this
 * (the 3-line contract format is line-oriented, and the terminal is the reader), so the guard
 * spells no second one.
 *
 * The RAW path stays in `at`: it is location metadata, and a machine reads it to open the file.
 */
const shown = (text: string): string => singleLine(text);

/** A site as a DIAGNOSTIC shows it — the path escaped, the line number as it is. */
const shownAt = (site: BareErrorSite | undefined): string => shown(at(site));

/** Every throw, new ones first — the package's first is usually one its pin already allows. */
const overFinding = (gap: BareErrorGap): Finding => ({
  code: 'X_TEST_BARE_ERROR',
  cause: `${shown(gap.pkg)} has ${String(gap.found)} test(s) reporting a verdict with a bare Error and is pinned at ${String(gap.pinned)} — ${siteList(gap, shownAt, EXPLAIN)} — and a bare Error carries no code, no cause and no fix, and reports at the throw rather than at the assertion`,
  fix: `replace the throw at ${siteTarget(gap, shownAt)}: expect.unreachable('<what was expected>') reports at the assertion, and its never return also narrows the variable, so the cast below it goes away`,
  at: at(leadSite(gap)),
});

const staleFinding = (gap: BareErrorGap): Finding => ({
  code: 'X_TEST_BARE_ERROR_PIN_STALE',
  cause: `${shown(gap.pkg)} is pinned at ${String(gap.pinned)} bare-Error throw(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/test-bare-error.ts --unpin ${shown(gap.pkg)}`,
  at: PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_BARE_ERROR_UNSCANNED',
  cause:
    'no test file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: "edit TEST_GLOBS in scripts/test-fix-citations.ts so it matches this repo's test layout",
  at: 'scripts/test-bare-error.ts',
});

/** The test scope's own findings — the per-package ratchet, unchanged. */
const testBareErrorFindingFor = (gap: BareErrorGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

/**
 * The row a source site answers to: the site itself, `path:line`.
 *
 * PER SITE, never per package: a per-package count let one exempt site be deleted and a real bare
 * throw added in the same file with no number moving — the swap `scripts/secret-compare.ts`
 * closed by grouping per site.
 */
const sourceRow = (path: string, line: number): string => `${path}:${String(line)}`;

/** A package for a test, the site itself for shipped source — the two scopes never share a row. */
const groupOf = (site: BareErrorSite): string =>
  isTestPath(site.path) ? packageOf(site.path) : sourceRow(site.path, site.line);

/** A source row is `path:line`; a package is a bare directory name, and never holds a `/`. */
const isSourceRow = (row: string): boolean => row.includes('/');

/** The exemption inventory as the ratchet's rows: one row per exempt site, holding one site. */
const exemptionRows = (exemptions: readonly SourceBareErrorExemption[]): PinTable =>
  Object.fromEntries(exemptions.map((one) => [sourceRow(one.path, one.line), 1]));

/** Both scopes' rows in one table: a package's test count, and the sites shipped source exempts. */
const PINS: PinTable = { ...BARE_ERROR_PINS, ...exemptionRows(SOURCE_BARE_ERROR_EXEMPTIONS) };

/**
 * The source scope's gaps over a hand-built input: the sites no exemption covers, and the
 * exemptions that match no site. Pure, so a test builds its input by hand instead of editing a
 * real file.
 *
 * The tree walk below answers the same question with BOTH scopes in ONE ratchet, so the command
 * and the gate step can never disagree; the rules are the same ones — the same scanner, the same
 * row, the same exemption table.
 */
export const checkSourceBareErrors = (
  files: readonly { readonly path: string; readonly text: string }[],
  exemptions: readonly SourceBareErrorExemption[],
): readonly BareErrorGap[] =>
  ratchetGaps(
    files.flatMap((file) => scanBareErrorThrows(file.path, file.text)),
    exemptionRows(exemptions),
    true,
    (site) => sourceRow(site.path, site.line),
  );

/** The exemption a row names, and the reason it was there. */
const exemptionOf = (row: string): SourceBareErrorExemption | undefined =>
  SOURCE_BARE_ERROR_EXEMPTIONS.find((one) => sourceRow(one.path, one.line) === row);

/** A bare throw in shipped source that no exemption covers. */
const sourceOverFinding = (gap: BareErrorGap): Finding => {
  const site = leadSite(gap);
  const where = site === undefined ? gap.pkg : `${site.path}:${String(site.line)}`;
  // The path as a DIAGNOSTIC shows it — `shown`. The RAW one stays in `at`.
  const place = shown(where);
  return {
    code: 'X_SOURCE_BARE_ERROR',
    cause: `${place} throws a bare builtin Error class in shipped source, and no exemption covers it — a bare Error carries no code, no cause and no fix, so whoever reads it is left with a stack`,
    fix: `bun run scripts/test-bare-error.ts --json   # then replace the throw at ${place} with a coded error — new UltimateError({ code, cause, fix }) from @ultimat3/core, or new ScriptError({ code, cause, fix }) from scripts/lib/script-error.ts in a script — or exempt the site in ${SOURCE_BARE_ERROR_EXEMPTIONS_FILE} with the reason it is allowed`,
    at: where,
  };
};

/** An exemption that matches no site: the throw it named was repaired, or the file is gone. */
const sourceStaleFinding = (gap: BareErrorGap): Finding => {
  const exemption = exemptionOf(gap.pkg);
  const reason =
    exemption === undefined ? '' : ` — the row was allowed because ${shown(exemption.reason)}`;
  return {
    code: 'X_SOURCE_BARE_ERROR_EXEMPT_STALE',
    cause: `the exemption for ${shown(gap.pkg)} matches no bare throw in shipped source${reason} — an exemption nobody reads is a licence the next throw inherits`,
    fix: `bun run scripts/test-bare-error.ts --json   # then delete the stale row from ${SOURCE_BARE_ERROR_EXEMPTIONS_FILE}`,
    at: SOURCE_BARE_ERROR_EXEMPTIONS_FILE,
  };
};

/**
 * The source scope's own findings. Only `over` and `stale` can reach it: the rows are plain
 * counts (a blank reason is a thing the TEST scope's table has and this one does not), and the
 * corpus read refuses rather than answering empty.
 */
const sourceBareErrorFindingFor = (gap: BareErrorGap): Finding =>
  gap.kind === 'over' ? sourceOverFinding(gap) : sourceStaleFinding(gap);

/** One finding per gap, whichever scope the gap belongs to. */
export const bareErrorFindingFor = (gap: BareErrorGap): Finding =>
  isSourceRow(gap.pkg) ? sourceBareErrorFindingFor(gap) : testBareErrorFindingFor(gap);

const treeSites = async (root: string): Promise<readonly BareErrorSite[]> =>
  (await readTestSources(root)).flatMap((file) => scanBareErrorThrows(file.path, file.text));

/** Shipped source: the `source` corpus without the test paths the test scope already reads. */
const sourceTreeSites = async (root: string): Promise<readonly BareErrorSite[]> =>
  (await corpus(root, 'source'))
    .filter((file) => !isTestPath(file.path))
    .flatMap((file) => scanBareErrorThrows(file.path, file.source));

/** Both scopes, as one list: a test site answers to its package, a source site to itself. */
const allSites = async (root: string): Promise<readonly BareErrorSite[]> => [
  ...(await treeSites(root)),
  ...(await sourceTreeSites(root)),
];

const PROBE: SiteProbe<BareErrorSite> = { rescan: scanBareErrorThrows, line: (site) => site.line };

export const bareErrorGaps = async (root: string): Promise<readonly BareErrorGap[]> =>
  newSitesFirst(root, ratchetGaps(await allSites(root), PINS, true, groupOf), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const bareErrorFindings = async (root: string): Promise<readonly Finding[]> =>
  (await bareErrorGaps(root)).map(bareErrorFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: PINS_FILE,
    pins: PINS,
    sites: allSites,
    findingFor: bareErrorFindingFor,
    probe: PROBE,
    groupOf,
    clean:
      'no package reports a test verdict with a bare Error above its pin, and no shipped source throws one',
  });
}
