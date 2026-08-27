#!/usr/bin/env bun
// Two rules, and the second exists because the first was resting on something untrue.
//
// 1. A package's `sideEffects` field must be TRUE of the package. A module that runs a statement at
//    import time and is reachable from `exports` has to be listed; an entry matching no file on
//    disk is a claim that has stopped being true.
// 2. A module the array names must also be ANCHORED — an entry itself, or bare-imported by one.
//
// **This header said "Bun honours the field" until 2026-08-27, and it does not.** Bun reads any
// `sideEffects` ARRAY as if it were `false` and shakes the named module away regardless
// (oven-sh/bun#40650, reduced to four files with no `@ultimat3/*`, deterministic on 1.4.0,
// 1.4.1-canary and 1.3.14 alike; esbuild keeps it on the same input). So rule 1 was enforcing a
// declaration nothing read: measured on `examples/dummy`'s feed island, 5 of the 8 declared effects
// in this tree — `core/context.ts`, `core/lifecycle-errors.ts`, `core/secrets-errors.ts`,
// `query/registry.ts`, `i18n/errors.ts` — were simply missing from the chunk, which is exactly the
// `registerErrorCodes()` deletion the rule exists to prevent, happening under a green gate.
//
// Rule 2 is what actually holds it: a bare `import './errors';` is a statement rather than a
// binding, so no shaker has a reason to drop it, on any bundler. The array STAYS — rollup, webpack
// and esbuild do honour it, and `@ultimat3/*` are published packages their consumers bundle — so
// this is additive and costs those consumers nothing. Real price, measured: +4,166 B on
// `feed.island.tsx` and +4,162 B on `like.island.tsx` (both still inside the 60 kB route budget),
// and 0 B on the two islands that reach none of these packages.
//
//
// Hazard a reader will hit, measured on Bun 1.4.0 and NOT this rule's doing: a package that
// declares `sideEffects` at all — an array or `false` — emits an INVALID chunk when its own
// `src/index.ts` is the entry point of a `Bun.build({ target: 'browser' })`, an `export { … }`
// clause naming identifiers whose declarations were shaken out. Bundling the barrel the way a
// consumer does (a module that imports or re-exports it) is unaffected, and that is the shape
// every app uses. `@ultimat3/schema` with a one-line `sideEffects: false` reproduces it.
//
//   bun run scripts/side-effects.ts [--json]
//   bun run scripts/side-effects.ts --explain [--json]     # the array this tree measures, per package
//   bun run scripts/side-effects.ts --unpin <pkg>[,<pkg>]  # shrink the ratchet

// why: Bun exposes no path-join primitive, and the pins file is rewritten by absolute path.
import { join } from 'node:path';
import { flagBool, flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import type { PackageFacts } from './lib/side-effects-scan';
import { readPackageFacts, SIDE_EFFECTS_ANCHORS } from './lib/side-effects-scan';

// Re-exported because they are this rule's vocabulary and its test imports them from here: the
// split at the 500-line ceiling is a file boundary, not a change to the surface.
export type { EffectModule, PackageFacts, TopLevelEffect } from './lib/side-effects-scan';
export {
  anchoredModules,
  PACKAGE_GLOB,
  reachableEffects,
  readPackageFacts,
  SIDE_EFFECTS_ANCHORS,
  scanTopLevelEffects,
  topLevelEffects,
} from './lib/side-effects-scan';

const SCRIPT = 'side-effects';
export const PINS_FILE = 'scripts/side-effects.ts';

/**
 * Packages that declare no `sideEffects` at all. A ratchet, not a red gate, for the reason
 * `gate-codes-backlog.ts` gives: 24 of 30 were silent the day this landed, and a rule that reds 24
 * rows at once is a rule somebody turns off. The list may shrink and may never grow — a NEW package
 * is red on arrival, which is the half that matters, because that is when the answer is cheap.
 *
 * Deliberately not drained wholesale: an array nobody measured is a claim, and `false` on a package
 * whose effects this scan cannot see is the exact lie the rule exists to refuse.
 * `--explain` prints what this tree measures for each; `--unpin` removes the entries that now hold.
 */
export const SIDE_EFFECTS_UNDECLARED: readonly string[] = [
  'packages/admin',
  'packages/ai',
  'packages/auth',
  'packages/cache',
  'packages/cli',
  'packages/create-ultimate',
  'packages/db',
  'packages/entity',
  'packages/flags',
  'packages/http',
  'packages/jobs',
  'packages/mail',
  'packages/manifest',
  'packages/mcp',
  'packages/policy',
  'packages/pwa',
  'packages/scraping',
  'packages/seo',
  'packages/storage',
  'packages/testing',
];

/**
 * A statement keyword can open a line at column 0 without the line being an effect. Everything else
 * anchored there and shaped like a call or an assignment IS one — that is the whole heuristic, and
 * its limits are stated on `scanTopLevelEffects` rather than guessed at by a reader.
 */
export const entryMatches = (entry: string, path: string): boolean =>
  new Bun.Glob(entry.replace(/^\.\//, '')).match(path);

export type SideEffectGapKind =
  | 'undeclared'
  | 'unanchored'
  | 'stale-entry'
  | 'missing'
  | 'pin-stale'
  | 'anchor-stale'
  | 'unscanned';

export interface SideEffectGap {
  readonly kind: SideEffectGapKind;
  readonly dir: string;
  /** The module or the entry the gap is about; empty for `missing` and `unscanned`. */
  readonly subject: string;
  readonly line?: number;
}

export interface SideEffectInput {
  readonly packages: readonly PackageFacts[];
  readonly pins: readonly string[];
  /**
   * `SIDE_EFFECTS_ANCHORS` in production. A parameter and not a module read, for the reason `pins`
   * is one: the staleness half below judges the table against the packages it was handed, so a
   * fixture that knows nothing about the real tree must be able to hand over its own — otherwise
   * every fixture check reports all three real anchors as stale.
   */
  readonly anchors: Readonly<Record<string, string>>;
}

/**
 * The whole rule. Vacuity is checked FIRST and in the opposite direction: a scan that read no
 * package, or found no import-time effect anywhere in a tree that has 30-odd `registerErrorCodes`
 * calls, reports a clean repo — the same answer a repo with no lies gives, which is why
 * `scripts/render-modes.ts` needed the identical guard.
 */
export function checkSideEffects(input: SideEffectInput): readonly SideEffectGap[] {
  const vacuous = (subject: string): readonly SideEffectGap[] => [
    { kind: 'unscanned', dir: PINS_FILE, subject },
  ];
  if (input.packages.length === 0) return vacuous('the scan walked no package');
  if (input.packages.every((one) => one.effects.length === 0)) {
    return vacuous('no package in this tree runs anything at import time, which cannot be true');
  }

  const gaps: SideEffectGap[] = [];
  for (const pkg of input.packages) {
    if (pkg.declared === undefined) {
      if (!input.pins.includes(pkg.dir)) gaps.push({ kind: 'missing', dir: pkg.dir, subject: '' });
      continue;
    }
    const entries = pkg.declared === false ? [] : pkg.declared;
    for (const effect of pkg.effects) {
      if (entries.some((entry) => entryMatches(entry, effect.path))) continue;
      gaps.push({ kind: 'undeclared', dir: pkg.dir, subject: effect.path, line: effect.line });
    }
    for (const entry of entries) {
      if (!pkg.files.some((file) => entryMatches(entry, file))) {
        gaps.push({ kind: 'stale-entry', dir: pkg.dir, subject: entry });
        continue;
      }
      // Only a `.ts`/`.tsx` module can be anchored by an import. `@ultimat3/ui`'s `**/*.scss` is a
      // stylesheet the bundler reaches through the component that uses it, and there is no import
      // statement that would make it unconditional.
      if (!/\.tsx?$/.test(entry)) continue;
      const path = entry.replace(/^\.\//, '');
      if (pkg.anchored.some((one) => one === path)) continue;
      // Only a REGISTRAR has to survive with none of its exports used — `isRegistrar` carries the
      // argument, and the cost of getting this wrong in the other direction is measured there.
      if (!Object.hasOwn(input.anchors, `${pkg.dir}/${path}`)) continue;
      gaps.push({ kind: 'unanchored', dir: pkg.dir, subject: path });
    }
  }
  // The same rule the table above is held to: a row naming a module no package declares
  // side-effecting is an argument for an anchor that protects nothing, and it reads as a rule still
  // in force. `X_TIER_FLOOR_STALE` is the identical half of `FLOOR_ABOVE`.
  const declaredModules = new Set(
    input.packages.flatMap((pkg) =>
      (pkg.declared === false || pkg.declared === undefined ? [] : pkg.declared)
        .filter((entry) => /\.tsx?$/.test(entry))
        .map((entry) => `${pkg.dir}/${entry.replace(/^\.\//, '')}`),
    ),
  );
  for (const anchor of Object.keys(input.anchors)) {
    if (!declaredModules.has(anchor)) {
      gaps.push({ kind: 'anchor-stale', dir: PINS_FILE, subject: anchor });
    }
  }
  // A pin nobody removes is a pin nobody reads — the ratchet only ratchets if it shrinks on its own.
  const silent = new Set(
    input.packages.filter((one) => one.declared === undefined).map((one) => one.dir),
  );
  for (const pin of input.pins) {
    if (!silent.has(pin)) gaps.push({ kind: 'pin-stale', dir: pin, subject: '' });
  }
  return gaps;
}

const FINDINGS: Readonly<Record<SideEffectGapKind, (gap: SideEffectGap) => Finding>> = {
  undeclared: (gap) => ({
    code: 'X_SIDE_EFFECTS_UNDECLARED',
    cause: `${gap.dir}/${gap.subject} runs a statement at import time and ${gap.dir}/package.json's sideEffects excludes it, so a bundler is told the module is droppable and deletes that statement from every app that does not use its exports`,
    fix: `add "./${gap.subject}" to "sideEffects" in ${gap.dir}/package.json — bun run side-effects --explain --json prints the array this tree measures`,
    at: `${gap.dir}/${gap.subject}:${String(gap.line ?? 1)}`,
  }),
  unanchored: (gap) => ({
    code: 'X_SIDE_EFFECTS_UNANCHORED',
    cause: `${gap.dir}/package.json names ${JSON.stringify(gap.subject)} in "sideEffects" and no entry module of ${gap.dir} imports it for effect, so nothing keeps it: Bun reads any sideEffects ARRAY as false and shakes the module out anyway (oven-sh/bun#40650), which deleted 5 of the 8 declared effects in this tree from examples/dummy's feed island`,
    fix: `add \`import './${gap.subject.replace(/^src\//, '').replace(/\.tsx?$/, '')}';\` to ${gap.dir}/src/index.ts — a bare import is in the module graph unconditionally, on every bundler, and costs nothing where the array was already honoured`,
    at: `${gap.dir}/package.json`,
  }),
  'stale-entry': (gap) => ({
    code: 'X_SIDE_EFFECTS_ENTRY_STALE',
    cause: `${gap.dir}/package.json declares sideEffects entry ${JSON.stringify(gap.subject)} and no file in ${gap.dir} matches it, so the entry protects nothing and reads as a rule that is still in force`,
    fix: `delete ${JSON.stringify(gap.subject)} from "sideEffects" in ${gap.dir}/package.json, or point it at the file it was written for`,
    at: `${gap.dir}/package.json`,
  }),
  missing: (gap) => ({
    code: 'X_SIDE_EFFECTS_MISSING',
    cause: `${gap.dir}/package.json declares no "sideEffects", so every module of it is retained in every bundle that imports one binding — measured 2026-08-21 with buildIslands: an island importing @ultimat3/time weighed 22,214 B and 5,948 B once @ultimat3/core declared one. That number is still the reason to declare one, and it is NOT a claim that Bun then keeps the named modules: it does not (oven-sh/bun#40650), which is what X_SIDE_EFFECTS_UNANCHORED is for`,
    fix: `run bun run side-effects --explain --json, copy this package's array into ${gap.dir}/package.json, then bun run scripts/side-effects.ts --unpin ${gap.dir}`,
    at: `${gap.dir}/package.json`,
  }),
  'anchor-stale': (gap) => ({
    code: 'X_SIDE_EFFECTS_ANCHOR_STALE',
    cause: `SIDE_EFFECTS_ANCHORS names ${gap.subject} and no package declares that module side-effecting, so the row argues for an anchor that protects nothing while reading as a rule still in force`,
    fix: `delete the ${JSON.stringify(gap.subject)} row from SIDE_EFFECTS_ANCHORS in scripts/lib/side-effects-scan.ts, or point it at the module it was written for`,
    at: 'scripts/lib/side-effects-scan.ts',
  }),
  'pin-stale': (gap) => ({
    code: 'X_SIDE_EFFECTS_PIN_STALE',
    cause: `${gap.dir} is pinned as declaring no sideEffects and now declares one, so the pin would let the field be deleted again in silence`,
    fix: `bun run scripts/side-effects.ts --unpin ${gap.dir}`,
    at: PINS_FILE,
  }),
  unscanned: (gap) => ({
    code: 'X_SIDE_EFFECTS_UNSCANNED',
    cause: `${gap.subject}, so every package reports clean and the rule enforces nothing — a scan that reads nothing looks exactly like a tree with no lies in it`,
    fix: `fix the walk in ${PINS_FILE}: PACKAGE_GLOB must match this repo's packages and scanTopLevelEffects must still read a registerErrorCodes call`,
    at: PINS_FILE,
  }),
};

export const sideEffectFinding = (gap: SideEffectGap): Finding => FINDINGS[gap.kind](gap);

export const sideEffectGaps = async (root: string): Promise<readonly SideEffectGap[]> =>
  checkSideEffects({
    packages: await readPackageFacts(root),
    pins: SIDE_EFFECTS_UNDECLARED,
    anchors: SIDE_EFFECTS_ANCHORS,
  });

/** What this repo contributes to `x verify`'s `unit` step, through `side-effects.test.ts`. */
export const sideEffectFindings = async (root: string): Promise<readonly Finding[]> =>
  (await sideEffectGaps(root)).map(sideEffectFinding);

/** The array this tree measures, per package — what a `missing` finding's fix line asks for. */
export const explainSideEffects = async (
  root: string,
): Promise<Readonly<Record<string, readonly string[]>>> =>
  Object.fromEntries(
    (await readPackageFacts(root)).map((pkg) => [
      pkg.dir,
      pkg.effects.map((effect) => `./${effect.path}`),
    ]),
  );

/**
 * Names `--unpin` cannot act on: not on the ratchet at all. Without this the summary answered
 * `nothing to lower — every named package still declares no sideEffects` for
 * `--unpin packages/does-not-exist`, which is `ok: true` for a typo and a sentence about a package
 * that does not exist. `reference-app-gate.ts --unpin` refuses the same way, with the same code.
 */
export const unknownPins = (names: readonly string[]): readonly string[] =>
  names.filter((name) => !SIDE_EFFECTS_UNDECLARED.includes(name));

/**
 * Lower the ratchet for the named packages, by editing the array above. The edit
 * `X_SIDE_EFFECTS_PIN_STALE` names, performed — a fix line that is a command is only true if the
 * command exists.
 */
export async function applyUnpin(
  root: string,
  names: readonly string[],
): Promise<readonly string[]> {
  const silent = new Set(
    (await readPackageFacts(root))
      .filter((pkg) => pkg.declared === undefined)
      .map((pkg) => pkg.dir),
  );
  const lowered = names.filter(
    (name) => SIDE_EFFECTS_UNDECLARED.includes(name) && !silent.has(name),
  );
  if (lowered.length === 0) return [];
  const path = join(root, PINS_FILE);
  const source = await Bun.file(path).text();
  const kept = SIDE_EFFECTS_UNDECLARED.filter((pin) => !lowered.includes(pin));
  const body = kept.map((pin) => `  '${pin}',\n`).join('');
  await Bun.write(
    path,
    source.replace(
      /(export const SIDE_EFFECTS_UNDECLARED: readonly string\[\] = \[\n)[\s\S]*?(\];)/,
      `$1${body}$2`,
    ),
  );
  return lowered;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  const unknown = unknownPins(unpin);
  if (unknown.length > 0) {
    const cause = `--unpin names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not on the ratchet, so nothing would have been lowered and the command would still have answered ok`;
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: cause,
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause,
            fix: `spell each one as its repo-relative directory, e.g. packages/action — the ratchet is the SIDE_EFFECTS_UNDECLARED array in ${PINS_FILE}`,
            at: PINS_FILE,
          },
        ],
      },
      args.json,
    );
  }
  if (unpin.length > 0) {
    const lowered = await applyUnpin(root, unpin);
    report(
      {
        ok: true,
        script: SCRIPT,
        summary:
          lowered.length === 0
            ? 'nothing to lower — every named package still declares no sideEffects'
            : `lowered ${String(lowered.length)} pin(s): ${lowered.join(', ')}`,
      },
      args.json,
    );
  } else if (flagBool(args, 'explain')) {
    const measured = await explainSideEffects(root);
    report(
      {
        ok: true,
        script: SCRIPT,
        summary: `measured import-time effects in ${String(Object.keys(measured).length)} package(s)`,
        lines: Object.entries(measured).map(
          ([dir, entries]) =>
            `  ${dir}: ${entries.length === 0 ? 'false' : JSON.stringify(entries)}`,
        ),
        data: { measured },
      },
      args.json,
    );
  } else {
    const gaps = await sideEffectGaps(root);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? 'every declared sideEffects field is true of its package'
            : `${String(gaps.length)} sideEffects gap(s)`,
        findings: gaps.map(sideEffectFinding),
      },
      args.json,
    );
  }
}
