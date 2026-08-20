#!/usr/bin/env bun
// Enforce, as a gate step, that this repo's TEST sources typecheck. Every package `tsconfig.json`
// excludes `src/**/*.test.ts`, so `bun run typecheck` has never read one: 966 test files in 30
// packages compiled nowhere, and the gate reported green over all of them. `tsconfig.tests.json`
// is the program that reads them — `noEmit`, so nothing lands in `dist/`.
//
// It ships on a RATCHET, not enforcing: 446 errors over 161 files remain, recorded per package in
// `scripts/lib/test-typecheck-pins.ts`, and that number may only fall. The edge is real all the
// same — a NEW test compiles the day it is written, and three packages are pinned at 0.
//
//   bun run scripts/test-typecheck-gate.ts [--json]
//   bun run scripts/test-typecheck-gate.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { flagList, parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import type { TestDiagnostic } from './lib/test-typecheck';
import { runTestTypecheck, TESTS_TSCONFIG } from './lib/test-typecheck';
import { PINS_FILE, pinnedFor, TEST_TYPECHECK_PINS } from './lib/test-typecheck-pins';
import { packageDirs } from './list-package-dirs';

const SCRIPT = 'test-typecheck-gate';

/**
 * `over` is the hazard: a package's tests failing more than it is pinned at, which is also how a
 * package pinned at 0 reports its first error. `stale` and `orphan` are the ratchet's own hygiene —
 * a pin nothing needs, and a pin for a package that is gone. `unscanned` is the false green: `tsc`
 * refusing to run would otherwise read as "every test typechecks".
 */
export type TestTypecheckGapKind = 'over' | 'stale' | 'orphan' | 'unscanned';

export interface TestTypecheckGap {
  readonly kind: TestTypecheckGapKind;
  readonly pkg: string;
  readonly errors: number;
  readonly pinned: number;
  readonly first?: TestDiagnostic;
  readonly detail?: string;
}

export interface TestTypecheckInput {
  /** The package directories on disk — the roster a pin is checked against. */
  readonly packages: readonly string[];
  readonly diagnostics: readonly TestDiagnostic[];
  readonly counts: Readonly<Record<string, number>>;
  readonly pins: Readonly<Record<string, number>>;
  /** Non-empty when nothing could be compiled at all. */
  readonly unscanned?: string;
}

const byPkg = (a: TestTypecheckGap, b: TestTypecheckGap): number =>
  a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0;

const firstFor = (
  diagnostics: readonly TestDiagnostic[],
  pkg: string,
): TestDiagnostic | undefined => diagnostics.find((one) => one.file.includes(`packages/${pkg}/`));

/** Pure, so both halves of the ratchet are tested from fixtures rather than from a real compile. */
export function checkTestTypecheck(input: TestTypecheckInput): readonly TestTypecheckGap[] {
  if (input.unscanned !== undefined || input.packages.length === 0) {
    return [
      {
        kind: 'unscanned',
        pkg: '',
        errors: 0,
        pinned: 0,
        detail: input.unscanned ?? `no package directory was found to compile tests for`,
      },
    ];
  }
  const gaps: TestTypecheckGap[] = [];
  for (const pkg of new Set([...input.packages, ...Object.keys(input.pins)])) {
    const errors = input.counts[pkg] ?? 0;
    const pinned = pinnedFor(pkg, input.pins);
    const first = firstFor(input.diagnostics, pkg);
    if (!input.packages.includes(pkg)) {
      gaps.push({ kind: 'orphan', pkg, errors, pinned });
      continue;
    }
    if (errors > pinned) {
      gaps.push({ kind: 'over', pkg, errors, pinned, ...(first === undefined ? {} : { first }) });
      continue;
    }
    if (errors < pinned) gaps.push({ kind: 'stale', pkg, errors, pinned });
  }
  return gaps.sort(byPkg);
}

/** The command that performs the edit, so every finding hands over a runnable line. */
export const unpinCommand = (packages: readonly string[]): string =>
  `bun run scripts/test-typecheck-gate.ts --unpin ${packages.join(',')}`;

const overFinding = (gap: TestTypecheckGap): Finding => {
  const at = gap.first === undefined ? PINS_FILE : `${gap.first.file}:${gap.first.line}`;
  const said =
    gap.first === undefined ? '' : `; the first says TS${gap.first.code}: ${gap.first.text}`;
  return {
    code: 'X_TEST_TYPECHECK_REGRESSED',
    cause: `${gap.pkg}'s tests carry ${gap.errors} typecheck error(s) and ${gap.pinned} are pinned${said}`,
    fix: `fix the error at ${at} — bun run scripts/test-typecheck-gate.ts --json prints every diagnostic — or raise '${gap.pkg}' to ${gap.errors} in ${PINS_FILE} on purpose`,
    at,
  };
};

const staleFinding = (gap: TestTypecheckGap): Finding => ({
  code: 'X_TEST_TYPECHECK_PIN_STALE',
  cause: `${PINS_FILE} pins ${gap.pinned} error(s) for ${gap.pkg} and ${gap.errors} remain — a ratchet that does not tighten is a ratchet nobody reads`,
  fix: unpinCommand([gap.pkg]),
  at: PINS_FILE,
});

const orphanFinding = (gap: TestTypecheckGap): Finding => ({
  code: 'X_TEST_TYPECHECK_PIN_STALE',
  cause: `${PINS_FILE} pins ${gap.pkg}, which is not a package directory — the pin excuses nothing and hides that nobody is checking it`,
  fix: unpinCommand([gap.pkg]),
  at: PINS_FILE,
});

const unscannedFinding = (gap: TestTypecheckGap): Finding => ({
  code: 'X_TEST_TYPECHECK_UNSCANNED',
  cause: `${gap.detail ?? ''}, so this rule reported green over tests it never compiled`,
  fix: `bun install, then bun run scripts/test-typecheck-gate.ts --json — the compiler is the repo's own node_modules/.bin/tsc and the program is ${TESTS_TSCONFIG}`,
  at: TESTS_TSCONFIG,
});

const FINDINGS: Readonly<Record<TestTypecheckGapKind, (gap: TestTypecheckGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  orphan: orphanFinding,
  unscanned: unscannedFinding,
};

export const testTypecheckFindingFor = (gap: TestTypecheckGap): Finding => FINDINGS[gap.kind](gap);

const BLOCK =
  /(export const TEST_TYPECHECK_PINS: Readonly<Record<string, number>> = \{\n)([\s\S]*?)(\n\};)/;
/** A package directory name and nothing else — `--unpin '.*'` must not become a regex that
 * matches every line in the table and rewrites all thirty. */
const NAME = /^[a-z][a-z0-9-]*$/;
const entryOf = (pkg: string): RegExp => new RegExp(`^(\\s*)('?${pkg}'?): (\\d+),$`);

/**
 * `--unpin <pkg>`, performed: a count lowered to what is measured, and a pin for a package that is
 * no longer on disk deleted outright. It never RAISES a count — that is a hand edit, in a review —
 * and it answers `undefined` at every disagreement rather than guessing which line to rewrite.
 */
export function unpinnedSource(
  source: string,
  targets: readonly string[],
  measured: Readonly<Record<string, number>>,
  packages: readonly string[],
): string | undefined {
  const block = BLOCK.exec(source);
  if (block === null || targets.length === 0) return undefined;
  if (targets.some((pkg) => !NAME.test(pkg))) return undefined;
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const line of (block[2] ?? '').split('\n')) {
    const target = targets.find((pkg) => entryOf(pkg).test(line));
    const match = target === undefined ? null : entryOf(target).exec(line);
    if (target === undefined || match === null) {
      kept.push(line);
      continue;
    }
    seen.add(target);
    // Gone from disk: the line goes with it, rather than being rewritten to a pin of zero for a
    // package nothing compiles.
    if (!packages.includes(target)) continue;
    const lowered = Math.min(Number(match[3]), measured[target] ?? 0);
    kept.push(`${match[1]}${match[2]}: ${lowered},`);
  }
  if (seen.size !== targets.length) return undefined;
  return source.replace(BLOCK, `$1${kept.join('\n')}$3`);
}

export const summaryOf = (gaps: readonly TestTypecheckGap[], errors: number): string =>
  gaps.length === 0
    ? `${errors} test typecheck error(s), every one pinned`
    : `${gaps.length} package(s) off the ratchet (${errors} test typecheck error(s))`;

/**
 * What this repo contributes to `x verify`'s `manifest` step.
 *
 * A root holding no package source directory at all is not a package monorepo and this rule has
 * nothing to say about it — `scripts/verify.test.ts` drives the step over temp fixture roots, and
 * a check that compiled there would answer about a tree that does not exist. Packages WITHOUT the
 * program is the other case entirely: the config was deleted, `tsc` refuses to start, and that
 * arrives as `X_TEST_TYPECHECK_UNSCANNED` rather than as a green run over 966 unread files.
 */
export async function testTypecheckFindings(root: string): Promise<readonly Finding[]> {
  const packages = packageDirs(root);
  if (packages.length === 0) return [];
  const measured = await runTestTypecheck(root);
  return checkTestTypecheck({
    packages,
    diagnostics: measured.diagnostics,
    counts: measured.counts,
    pins: TEST_TYPECHECK_PINS,
    ...(measured.failure === undefined ? {} : { unscanned: measured.failure }),
  }).map(testTypecheckFindingFor);
}

const badFlag = (cause: string, fix: string): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary: cause,
  findings: [{ code: 'X_CLI_BAD_FLAG', cause, fix, at: PINS_FILE }],
});

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const packages = packageDirs(root);
  const measured = await runTestTypecheck(root);
  const gaps = checkTestTypecheck({
    packages,
    diagnostics: measured.diagnostics,
    counts: measured.counts,
    pins: TEST_TYPECHECK_PINS,
    ...(measured.failure === undefined ? {} : { unscanned: measured.failure }),
  });
  const targets = flagList(args, 'unpin');
  if (targets.length > 0) {
    const path = `${root}/${PINS_FILE}`;
    const next = unpinnedSource(await Bun.file(path).text(), targets, measured.counts, packages);
    if (next === undefined) {
      report(
        badFlag(
          `--unpin names ${targets.join(', ')}, and ${PINS_FILE} has no line this edit can read for every one of them`,
          `bun run scripts/test-typecheck-gate.ts --json   # the pins each package still carries`,
        ),
        args.json,
      );
    }
    await Bun.write(path, next);
    report(
      {
        ok: true,
        script: SCRIPT,
        summary: `${targets.map((pkg) => `${pkg}: ${measured.counts[pkg] ?? 0}`).join(', ')} — ${PINS_FILE} rewritten`,
        lines: ['  now run: bun run scripts/test-typecheck-gate.ts'],
        data: { unpinned: targets, counts: measured.counts },
      },
      args.json,
    );
  }
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary: summaryOf(gaps, measured.diagnostics.length),
      findings: gaps.map(testTypecheckFindingFor),
      lines: packages.map(
        (pkg) => `  ${pkg.padEnd(16)} ${measured.counts[pkg] ?? 0} / ${pinnedFor(pkg)} pinned`,
      ),
      data: { counts: measured.counts, errors: measured.diagnostics.length },
    },
    args.json,
  );
}
