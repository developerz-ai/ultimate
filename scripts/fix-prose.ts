#!/usr/bin/env bun
// Enforce, as a ratchet, that a `fix:` is a runnable command or a pasteable code shape, never prose.
//
// The error contract says a fix is "a command to run, a call to paste, or an edit naming a file",
// and the `errors` step holds it to half of that: a banned phrase with nothing runnable beside it
// (`fixProblem`), and a cited `x` command that must exist. Neither asks whether the line OPENS with
// something a reader can run — so `set pwa.offline.fallback in app.config.ts to a path a route
// serves` passes both, and is a sentence an agent has to translate before it can act. Measured on
// the first run: 968 of 1,633 readable fix lines in shipped source are prose.
//
// The shape is read off how the line opens (`lib/fix-shape.ts`): a command word, a repo script, an
// environment prefix, or a code shape. A fix that opens with a `${…}` is the value's shape and is
// not counted. Same file set and fix scan as the `errors` step — one scanner, never a second.
//
//   bun run scripts/fix-prose.ts [--json] [--explain]
//   bun run scripts/fix-prose.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

// why: Bun exposes no path-join primitive, and the scan reads every source file by its repo path.
import { join } from 'node:path';
import { createHelperResolver } from '../packages/cli/src/fix-imports';
import { scanFixSites } from '../packages/cli/src/fix-scan';
import { eachSourceFile, isGenerated, isTest } from '../packages/cli/src/source-files';
import { renderFixShellArg } from '../packages/core/src/error-render';
import { FIX_PROSE_PINS, FIX_PROSE_PINS_FILE } from './lib/fix-prose-pins';
import { fixShape } from './lib/fix-shape';
import type { Finding } from './lib/log';
import type { RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import { siteList } from './lib/ratchet-sites';

const SCRIPT = 'fix-prose';
const EXPLAIN = 'bun run scripts/fix-prose.ts --explain --json lists every one';

/** Source the CLI EMITS into an app rather than runs — held to the contract by its own test. */
const TEMPLATE_ROOT = 'packages/cli/src/templates/';

export interface FixProseSite {
  readonly path: string;
  readonly line: number;
  readonly fix: string;
}

/** Every prose fix in one file's source, given the helpers it imports. */
export const proseFixes = (
  path: string,
  source: string,
  imported: Parameters<typeof scanFixSites>[2] = [],
): readonly FixProseSite[] =>
  scanFixSites(source, path, imported)
    .sites.filter((site) => fixShape(site.fix) === 'prose')
    .map((site) => ({ path, line: site.line, fix: site.fix }));

/** The prose sites, and how many fix lines were read at all — zero read is never a clean tree. */
export async function fixProseScan(
  root: string,
): Promise<{ readonly sites: readonly FixProseSite[]; readonly read: number }> {
  const imports = createHelperResolver(root);
  const sites: FixProseSite[] = [];
  let read = 0;
  for await (const path of eachSourceFile(root)) {
    if (isTest(path) || isGenerated(path) || path.startsWith(TEMPLATE_ROOT)) continue;
    const source = await Bun.file(join(root, path)).text();
    const imported = await imports(path, source);
    read += scanFixSites(source, path, imported).sites.length;
    sites.push(...proseFixes(path, source, imported));
  }
  return { sites, read };
}

export const fixProseSites = async (root: string): Promise<readonly FixProseSite[]> =>
  (await fixProseScan(root)).sites;

export type FixProseGap = RatchetGap<FixProseSite>;

const at = (site: FixProseSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: FixProseGap): Finding => ({
  code: 'X_FIX_PROSE',
  cause: `${gap.pkg} has ${String(gap.found)} fix: line(s) that open with prose and is pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — and a fix is pasted from its first character, so a sentence is an instruction the reader has to translate first. Open the new line with the command or the code to paste, and move the sentence into its cause`,
  fix: 'bun run scripts/fix-prose.ts --explain --json',
  at: at(gap.first),
});

const staleFinding = (gap: FixProseGap): Finding => ({
  code: 'X_FIX_PROSE_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} prose fix: line(s) and has ${String(gap.found)} — the pin would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/fix-prose.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
  at: FIX_PROSE_PINS_FILE,
});

const unexplainedFinding = (gap: FixProseGap): Finding => ({
  code: 'X_FIX_PROSE_PIN_UNEXPLAINED',
  cause: `${gap.pkg} is pinned with a blank reason, so its ${String(gap.found)} prose fix: line(s) are held by nothing — rewrite those lines, or write the reason into its row in ${FIX_PROSE_PINS_FILE}`,
  fix: 'bun run scripts/fix-prose.ts --explain --json',
  at: FIX_PROSE_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_FIX_PROSE_UNSCANNED',
  cause:
    'no fix: line was read, so every package reports zero and the ratchet enforces nothing — a scan that reads nothing looks exactly like a tree with no prose in it',
  fix: 'bun run scripts/fix-prose.ts --explain --json',
  at: 'packages/cli/src/source-files.ts',
});

/** A `switch`, as `fix-shell-arg.ts` explains: a computed read of a Record trips `proto-index`. */
export const fixProseFindingFor = (gap: FixProseGap): Finding => {
  switch (gap.kind) {
    case 'over':
      return overFinding(gap);
    case 'stale':
      return staleFinding(gap);
    case 'unexplained':
      return unexplainedFinding(gap);
    case 'unscanned':
      return unscannedFinding();
  }
};

export const fixProseGaps = async (root: string): Promise<readonly FixProseGap[]> => {
  const scan = await fixProseScan(root);
  return ratchetGaps(scan.sites, FIX_PROSE_PINS, scan.read > 0);
};

/** What this rule contributes to `x verify`'s `errors` step. */
export const fixProseFindings = async (root: string): Promise<readonly Finding[]> =>
  (await fixProseGaps(root)).map(fixProseFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: FIX_PROSE_PINS_FILE,
    pins: FIX_PROSE_PINS,
    sites: fixProseSites,
    findingFor: fixProseFindingFor,
    clean: 'every package holds at or under its pin of prose fix: lines',
  });
}
