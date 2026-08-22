#!/usr/bin/env bun
// One rule: a package's `sideEffects` field must be TRUE of the package. A module that runs a
// statement at import time and is reachable from `exports` has to be listed; an entry matching no
// file on disk is a claim that has stopped being true. A lie here is silent — Bun honours the
// field, so an omitted module is a `registerErrorCodes()` deleted from a real browser bundle.
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

import { dirname, join } from 'node:path';
import { maskLiterals, stripComments } from '@ultimat3/cli';
import { flagBool, flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

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
  'packages/action',
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
  'packages/query',
  'packages/schema',
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
const KEYWORDS = new Set(
  (
    'export import const let var function class type interface enum declare namespace abstract ' +
    'async default return if for while switch try catch finally else do case break continue ' +
    'throw new with from await yield'
  ).split(' '),
);

/** `foo(`, `foo.bar(`, `foo?.bar(` or `foo = ` — a call or an assignment, at column 0. */
const STATEMENT = /^([A-Za-z_$][\w$]*)(?:\??\.[\w$]+)*\s*(?:\(|=[^=>])/;

/** `import './x'` and `import x from './y'` and `export … from './z'` and `import('./w')`. */
const SPECIFIER =
  /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * The 1-based lines on which this module runs something at import time.
 *
 * Read from `stripComments` so a commented-out call is not a finding, and cross-checked against
 * `maskLiterals` so a call quoted inside a template literal is not either — `packages/render/src/
 * hydrate.ts` emits the browser boot script as a string with `if(!e)return…` at column 0, and
 * `packages/cli/src/templates/` emits whole modules that way. Reporting one invents a finding no
 * edit can clear, which is worse than no guard.
 *
 * What it does NOT see, and therefore what needs review rather than a green check: an effect
 * indented inside a top-level block or IIFE, a top-level `await`, a class `static {}` block, and a
 * constructor that registers itself when its `const` is evaluated. Those are silence, not findings
 * — the vacuity guard in `checkSideEffects` is what keeps that silence from becoming the answer.
 */
export function scanTopLevelEffects(source: string): readonly number[] {
  const lines = stripComments(source).split('\n');
  const masked = maskLiterals(source).split('\n');
  const found: number[] = [];
  lines.forEach((line, index) => {
    const match = STATEMENT.exec(line);
    if (match === null || KEYWORDS.has(match[1] as string)) return;
    // Column 0 of the masked line is a space exactly when the text was inside a string literal.
    if ((masked[index] ?? '')[0] === ' ') return;
    found.push(index + 1);
  });
  return found;
}

/**
 * Whether one `sideEffects` entry covers one package-relative path. Entries are globs rooted at the
 * package, so `./src/errors.ts` and `src/errors.ts` are the same entry, and a recursive glob reaches
 * any depth. A `false` field covers nothing, which is what makes it the strongest claim a package
 * can make and the one this rule checks hardest.
 */
export const entryMatches = (entry: string, path: string): boolean =>
  new Bun.Glob(entry.replace(/^\.\//, '')).match(path);

export interface EffectModule {
  /** Package-relative POSIX path, e.g. `src/errors.ts`. */
  readonly path: string;
  readonly line: number;
}

export interface PackageFacts {
  /** Repo-relative directory, e.g. `packages/core` — the key the ratchet pins on. */
  readonly dir: string;
  readonly name: string;
  /** The field verbatim: an array, `false`, or `undefined` when the package declares none. */
  readonly declared: readonly string[] | false | undefined;
  /** Every file the package ships, package-relative — what a stale entry is checked against. */
  readonly files: readonly string[];
  /** Import-time effects in modules reachable from `exports`, first line each. */
  readonly effects: readonly EffectModule[];
}

export type SideEffectGapKind =
  | 'undeclared'
  | 'stale-entry'
  | 'missing'
  | 'pin-stale'
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
      if (pkg.files.some((file) => entryMatches(entry, file))) continue;
      gaps.push({ kind: 'stale-entry', dir: pkg.dir, subject: entry });
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
  'stale-entry': (gap) => ({
    code: 'X_SIDE_EFFECTS_ENTRY_STALE',
    cause: `${gap.dir}/package.json declares sideEffects entry ${JSON.stringify(gap.subject)} and no file in ${gap.dir} matches it, so the entry protects nothing and reads as a rule that is still in force`,
    fix: `delete ${JSON.stringify(gap.subject)} from "sideEffects" in ${gap.dir}/package.json, or point it at the file it was written for`,
    at: `${gap.dir}/package.json`,
  }),
  missing: (gap) => ({
    code: 'X_SIDE_EFFECTS_MISSING',
    cause: `${gap.dir}/package.json declares no "sideEffects", so every module of it is retained in every bundle that imports one binding — measured 2026-08-21 with buildIslands: an island importing @ultimat3/time weighed 22,214 B and 5,948 B once @ultimat3/core declared one`,
    fix: `run bun run side-effects --explain --json, copy this package's array into ${gap.dir}/package.json, then bun run scripts/side-effects.ts --unpin ${gap.dir}`,
    at: `${gap.dir}/package.json`,
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

export const PACKAGE_GLOB = 'packages/*/package.json';

const SKIP = /(?:^|\/)(?:node_modules|dist|\.turbo)\//;
const isTest = (path: string): boolean => /\.(test|spec)\.tsx?$/.test(path);

/** The `exports` map's own targets, flattened across conditions. */
const exportTargets = (exports: unknown): readonly string[] => {
  if (typeof exports === 'string') return [exports];
  if (exports === null || typeof exports !== 'object') return [];
  return Object.values(exports as Record<string, unknown>).flatMap(exportTargets);
};

/**
 * Under the package, and not merely reachable from it. `join` collapses `..`, so a relative
 * specifier CAN leave: `../../core/src/errors` resolves to a real file, and `path` below is then
 * `file.slice(absolute.length + 1)` — ANOTHER package's absolute path sliced at this one's length.
 * Measured on a scratch tree: `packages/beta/src/effect.ts` reached from `packages/alpha` reported
 * `packages/alpha/rc/effect.ts`, a file in neither, and the two findings chase each other —
 * `X_SIDE_EFFECTS_UNDECLARED` demands the entry, `X_SIDE_EFFECTS_ENTRY_STALE` refuses it because
 * nothing on disk matches, and no edit clears either. The exact shape lines 92-93 argue against.
 */
const inside = (absolute: string, file: string): boolean => file.startsWith(`${absolute}/`);

const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

async function resolveRelative(from: string, spec: string): Promise<string | null> {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(from), spec);
  for (const suffix of CANDIDATES) {
    const candidate = `${base}${suffix}`;
    if (!/\.tsx?$/.test(candidate)) continue;
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

/**
 * Every module reachable from the package's `exports`, and the import-time effects in each. One
 * walk for both, because they are one question: a build script under `src/` that nothing exports
 * (`if (import.meta.main)`, `bin.ts`) must NOT be demanded in the field — noise in `sideEffects` is
 * how the field stops being read, and this is where the noise is filtered out.
 *
 * Relative specifiers only, and only INSIDE the package — a cross-package import stops at the
 * boundary, which is the other package's `sideEffects` to answer for. `inside` is what makes that
 * sentence true rather than merely written.
 */
export async function reachableEffects(
  root: string,
  dir: string,
  exports: unknown,
): Promise<readonly EffectModule[]> {
  const absolute = join(root, dir);
  const queue = exportTargets(exports)
    .filter((target) => /\.tsx?$/.test(target))
    .map((target) => join(absolute, target))
    .filter((file) => inside(absolute, file));
  const seen = new Set<string>();
  const effects: EffectModule[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !(await Bun.file(file).exists())) continue;
    seen.add(file);
    const source = await Bun.file(file).text();
    const lines = scanTopLevelEffects(source);
    const first = lines[0];
    if (first !== undefined && !isTest(file)) {
      effects.push({ path: file.slice(absolute.length + 1), line: first });
    }
    for (const match of stripComments(source).matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec === undefined) continue;
      const resolved = await resolveRelative(file, spec);
      if (resolved !== null && inside(absolute, resolved)) queue.push(resolved);
    }
  }
  return effects.sort((a, b) => a.path.localeCompare(b.path));
}

const declaredField = (value: unknown): readonly string[] | false | undefined => {
  if (value === false) return false;
  if (Array.isArray(value)) return value.filter((one): one is string => typeof one === 'string');
  return undefined;
};

export async function readPackageFacts(root: string): Promise<readonly PackageFacts[]> {
  const facts: PackageFacts[] = [];
  for (const manifest of new Bun.Glob(PACKAGE_GLOB).scanSync({ cwd: root })) {
    const dir = dirname(manifest);
    const parsed: unknown = await Bun.file(join(root, manifest)).json();
    const pkg = parsed as { name?: string; sideEffects?: unknown; exports?: unknown };
    const files = [...new Bun.Glob('**/*').scanSync({ cwd: join(root, dir), onlyFiles: true })]
      .map((path) => path.split('\\').join('/'))
      .filter((path) => !SKIP.test(`/${path}`));
    facts.push({
      dir,
      name: pkg.name ?? dir,
      declared: declaredField(pkg.sideEffects),
      files,
      effects: await reachableEffects(root, dir, pkg.exports),
    });
  }
  return facts.sort((a, b) => a.dir.localeCompare(b.dir));
}

export const sideEffectGaps = async (root: string): Promise<readonly SideEffectGap[]> =>
  checkSideEffects({ packages: await readPackageFacts(root), pins: SIDE_EFFECTS_UNDECLARED });

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
