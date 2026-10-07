#!/usr/bin/env bun
// Enforce, as a gate step, that a fenced `ts`/`tsx` example in a package README typechecks. A
// README example is the first code an agent copies, and nothing compiled one: `packages/render`'s
// calls `config.meta({ post })` where `meta` takes a `RouteMetaContext` — the shape the same page
// documents four lines earlier — and `packages/jobs`' `jobWorker({ driver, queues, concurrency })`
// omits a non-optional field. Both read as authoritative and neither would compile.
//
// It ships on a RATCHET, not enforcing: 155 of 170 examples are illustrative fragments today
// (`scripts/readme-fences-backlog.ts` records them per FENCE — package plus first code line — and a
// row may only fall). The edge is real all the same — a NEW example must compile the day it is
// written, and per fence since plan 101 sweep 11c it cannot be traded for a fixed one.
//
//   bun run scripts/readme-fences.ts [--json] [--pin]

import { flagBool, parseScriptArgs } from './lib/args';
import { fenceSite, loweredRows, pageOfSite, siteTally } from './lib/fence-sites';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { Diagnostic, Fence, Fixture } from './lib/readme-fences';
import {
  buildFixtures,
  compileFixtures,
  fenceOf,
  isSyntactic,
  readAllFences,
} from './lib/readme-fences';
import { repoRoot } from './lib/run';
import { pinnedFor, README_FENCE_BACKLOG } from './readme-fences-backlog';

export const BACKLOG_FILE = 'scripts/readme-fences-backlog.ts';

/** One example that does not compile, with the first thing the compiler said about it. */
export interface FenceFailure {
  readonly pkg: string;
  readonly readmeLine: number;
  readonly reason: string;
  /** `<pkg>: <first code line>` — the backlog row this failure is counted against. */
  readonly site: string;
}

/**
 * `over` is the hazard: a package failing more examples than it is pinned at. `stale` is the
 * ratchet's own hygiene. `unscanned` is the false green — no README read, or `tsc` refusing to run,
 * either of which would otherwise report "every example compiles".
 */
export type FenceGapKind = 'over' | 'stale' | 'unscanned';

export interface FenceGap {
  readonly kind: FenceGapKind;
  readonly pkg: string;
  /** The backlog row: `<pkg>: <first code line>`. Empty for `unscanned`. */
  readonly site: string;
  readonly failing: number;
  readonly pinned: number;
  readonly failures: readonly FenceFailure[];
  readonly detail?: string;
}

export interface FenceInput {
  readonly packages: readonly string[];
  readonly failures: readonly FenceFailure[];
  readonly backlog: Readonly<Record<string, number>>;
  /** Non-empty when nothing could be compiled at all. */
  readonly unscanned?: string;
}

const bySite = (a: FenceGap, b: FenceGap): number =>
  a.site < b.site ? -1 : a.site > b.site ? 1 : 0;

/** Pure, so the negative case is a fixture rather than an edit to a README someone else owns. */
export function checkFences(input: FenceInput): readonly FenceGap[] {
  if (input.unscanned !== undefined || input.packages.length === 0) {
    return [
      {
        kind: 'unscanned',
        pkg: '',
        site: '',
        failing: 0,
        pinned: 0,
        failures: [],
        detail: input.unscanned ?? 'no package README carries a fenced ts or tsx example',
      },
    ];
  }
  const gaps: FenceGap[] = [];
  const sites = new Set([...input.failures.map((one) => one.site), ...Object.keys(input.backlog)]);
  for (const site of sites) {
    const failures = input.failures.filter((one) => one.site === site);
    const pinned = pinnedFor(site, input.backlog);
    const at = { pkg: pageOfSite(site), site, failing: failures.length, pinned, failures };
    if (failures.length > pinned) gaps.push({ kind: 'over', ...at });
    else if (failures.length < pinned) gaps.push({ kind: 'stale', ...at });
  }
  return gaps.sort(bySite);
}

const readme = (pkg: string): string => `packages/${pkg}/README.md`;

const overFinding = (gap: FenceGap): Finding => {
  const first = gap.failures[0];
  const lines = gap.failures.map((one) => one.readmeLine).join(', ');
  return {
    code: 'X_README_EXAMPLE_UNCOMPILED',
    cause: `${gap.failures.length} fenced example(s) in ${readme(gap.pkg)} opening \`${gap.site.slice(gap.pkg.length + 2)}\` do not typecheck and ${gap.pinned} are pinned — failing at line(s) ${lines}; the first says: ${first?.reason ?? ''}`,
    fix: `make the example at ${readme(gap.pkg)}:${first?.readmeLine ?? 0} compile — bun run scripts/readme-fences.ts --json prints every diagnostic — or pin its row in ${BACKLOG_FILE} at ${gap.failures.length} on purpose, with a // why:`,
    at: `${readme(gap.pkg)}:${first?.readmeLine ?? 0}`,
  };
};

const staleFinding = (gap: FenceGap): Finding => ({
  code: 'X_README_EXAMPLE_PIN_STALE',
  cause: `${BACKLOG_FILE} pins ${gap.pinned} failing example(s) at '${gap.site}' and ${gap.failing} fail now — a ratchet that does not tighten is a ratchet nobody reads`,
  fix: 'bun run scripts/readme-fences.ts --pin',
  at: BACKLOG_FILE,
});

const unscannedFinding = (gap: FenceGap): Finding => ({
  code: 'X_README_EXAMPLE_UNSCANNED',
  cause: `${gap.detail ?? ''}, so this rule reported green over examples it never compiled`,
  fix: "bun install, then bun run scripts/readme-fences.ts --json — the compiler is the repo's own node_modules/.bin/tsc and the inputs are packages/*/README.md",
  at: BACKLOG_FILE,
});

const FINDINGS: Readonly<Record<FenceGapKind, (gap: FenceGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const fenceGapFindingFor = (gap: FenceGap): Finding => FINDINGS[gap.kind](gap);

/** One failure per fence, carrying the FIRST thing the compiler said about it. */
export const failuresFrom = (
  fixtures: readonly Fixture[],
  diagnostics: readonly Diagnostic[],
): readonly FenceFailure[] => {
  const first = new Map<Fence, string>();
  for (const diagnostic of diagnostics) {
    const fence = fenceOf(fixtures, diagnostic.file);
    if (fence === undefined || first.has(fence)) continue;
    first.set(fence, `TS${diagnostic.code}: ${diagnostic.text}`);
  }
  return [...first].map(([fence, reason]) => ({
    pkg: fence.pkg,
    readmeLine: fence.readmeLine,
    reason,
    site: fenceSite(fence),
  }));
};

/**
 * Compile, drop what will not PARSE, compile again. Exactly two passes.
 *
 * `tsc` reports NO semantic diagnostics for a program holding a syntax error anywhere in it —
 * measured: a fixture with `const a: number = 'x'` beside one unparseable fence reports the fence
 * and says nothing about the assignment. A single pass would therefore have gone quiet across all
 * 27 packages the day one README gained an elided `…`, reading green over every type error in the
 * repo's documentation. Two are enough because removing a fence cannot make another unparseable:
 * one fixture is one fence, and they share no scope.
 */
export async function fenceFailures(root: string): Promise<{
  readonly packages: readonly string[];
  readonly failures: readonly FenceFailure[];
  readonly unscanned?: string;
}> {
  const fences = await readAllFences(root);
  const packages = [...new Set(fences.map((fence) => fence.pkg))].sort();
  if (fences.length === 0) return { packages: [], failures: [] };
  const all = buildFixtures(fences);
  const one = await compileFixtures(root, all);
  if (one.failure !== undefined) return { packages, failures: [], unscanned: one.failure };
  const unparseable = failuresFrom(all, one.diagnostics.filter(isSyntactic));
  if (unparseable.length === 0) return { packages, failures: failuresFrom(all, one.diagnostics) };
  const broken = new Set(unparseable.map((fail) => `${fail.pkg}:${fail.readmeLine}`));
  const rest = buildFixtures(fences, (fence) => broken.has(`${fence.pkg}:${fence.readmeLine}`));
  const two = await compileFixtures(root, rest);
  if (two.failure !== undefined) return { packages, failures: unparseable, unscanned: two.failure };
  return { packages, failures: [...unparseable, ...failuresFrom(rest, two.diagnostics)] };
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function readmeFenceFindings(root: string): Promise<readonly Finding[]> {
  const measured = await fenceFailures(root);
  return checkFences({ ...measured, backlog: README_FENCE_BACKLOG }).map(fenceGapFindingFor);
}

/** `--pin`: lower each row to what is measured. It never raises one — that is a reviewed edit. */
export function pinnedSource(
  measured: Readonly<Record<string, number>>,
  backlog: Readonly<Record<string, number>>,
  source: string,
): string {
  return source.replace(
    /(export const README_FENCE_BACKLOG: Readonly<Record<string, number>> = \{\n)[\s\S]*?(\n\};)/,
    (_whole, open: string, close: string) => `${open}${loweredRows(measured, backlog)}${close}`,
  );
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const measured = await fenceFailures(root);
  const gaps = checkFences({ ...measured, backlog: README_FENCE_BACKLOG });
  if (flagBool(args, 'pin')) {
    const path = `${root}/${BACKLOG_FILE}`;
    const text = await Bun.file(path).text();
    await Bun.write(path, pinnedSource(siteTally(measured.failures), README_FENCE_BACKLOG, text));
  }
  const total = measured.failures.length;
  report(
    {
      ok: gaps.length === 0,
      script: 'readme-fences',
      summary:
        gaps.length === 0
          ? `${measured.packages.length} package READMEs, ${total} fenced example(s) failing, every one pinned`
          : `${gaps.length} README fence site(s) off the ratchet (${total} failing)`,
      findings: gaps.map(fenceGapFindingFor),
      data: { failures: measured.failures },
    },
    args.json,
  );
}
