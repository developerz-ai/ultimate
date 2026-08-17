#!/usr/bin/env bun
// Enforce, as a gate step, that the realtime capacity figures `CLAUDE.md` states are the figures
// the committed bench results carry. They are the repo's loudest measured claim and the first thing
// an agent reads, and nothing compared them to `scripts/bench/results/*.json` — so a re-run that
// moved a percentile, or a hand-edited sentence, left the framework describing a run that never
// happened. Runs on `x verify`'s `manifest` step: "does a committed file still describe the code?"
// is that step's own question, and `CLAUDE.md` is the file an agent reads first.
//
// THE ROUNDING CONVENTION, decided here because the prose was ambiguous: a duration renders as
// `(ms / 1000).toFixed(1)` seconds — 53951ms is `54.0s` — and a count renders with `,` every three
// digits. Nothing else is accepted. `toFixed` is what a value landing exactly on a `.x5` boundary
// settles by, so the fix line always carries the string to write rather than asking for a decision.
//
//   bun run scripts/bench-claims.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const CLAIMS_FILE = 'CLAUDE.md';
export const RESULTS_50K = 'scripts/bench/results/50k-restart.json';
export const RESULTS_10K = 'scripts/bench/results/10k-restart-seq.json';

/** How a measured number is spelled in prose. */
export type BenchFormat = 'count' | 'seconds' | 'plain';

export interface BenchClaim {
  /** What the sentence asserts, in the words the fix line will use. */
  readonly label: string;
  readonly file: string;
  /** Dot path into that file's JSON. */
  readonly path: string;
  readonly format: BenchFormat;
  /**
   * One capture group, matched against the prose with whitespace collapsed — the claims wrap across
   * lines, and a pattern that could not cross a newline would report every one of them as vanished.
   */
  readonly pattern: RegExp;
}

/**
 * Anchored patterns, never a bare search for the digits: `50,000` appears four times in this file,
 * and "the number is somewhere on the page" would pass over a sentence that had been rewritten to
 * say something else about it.
 */
export const CLAIMS: readonly BenchClaim[] = [
  {
    label: "the reachability run's client count",
    file: RESULTS_50K,
    path: 'clients',
    format: 'count',
    pattern: /Reachability, ([\d,]+) clients:/,
  },
  {
    label: 'clients that reconnected after the kill',
    file: RESULTS_50K,
    path: 'restart.reconnect.count',
    format: 'count',
    pattern: /All ([\d,]+) reconnected;/,
  },
  {
    label: 'clients that received a patch in the window',
    file: RESULTS_50K,
    path: 'restart.consistent.count',
    format: 'count',
    pattern: /\*\*([\d,]+)\*\* received a channel patch/,
  },
  {
    label: 'first-delivery p50',
    file: RESULTS_50K,
    path: 'restart.consistent.p50Ms',
    format: 'seconds',
    pattern: /p50 ([\d.]+)s \/ p90/,
  },
  {
    label: 'first-delivery p90',
    file: RESULTS_50K,
    path: 'restart.consistent.p90Ms',
    format: 'seconds',
    pattern: /p90 ([\d.]+)s \/ max/,
  },
  {
    label: 'first-delivery max',
    file: RESULTS_50K,
    path: 'restart.consistent.maxMs',
    format: 'seconds',
    pattern: /\/ max ([\d.]+)s;/,
  },
  {
    label: 'connect attempts the AcceptBudget shed',
    file: RESULTS_50K,
    path: 'restart.shedAttempts',
    format: 'count',
    pattern: /([\d,]+) connect attempts shed/,
  },
  {
    label: "the delivery run's client count",
    file: RESULTS_10K,
    path: 'clients',
    format: 'count',
    pattern: /Delivery, ([\d,]+) clients:/,
  },
  {
    label: 'the probe interval',
    file: RESULTS_10K,
    path: 'probeIntervalMs',
    format: 'plain',
    pattern: /a probe every (\d+)ms/,
  },
  {
    label: 'clients that reconnected in the delivery run',
    file: RESULTS_10K,
    path: 'restart.reconnect.count',
    format: 'count',
    pattern: /all ([\d,]+) reconnected:/,
  },
  {
    label: 'patches received',
    file: RESULTS_10K,
    path: 'seq.received',
    format: 'count',
    pattern: /\*\*([\d,]+) patches received/,
  },
  {
    label: 'observed sequence gaps',
    file: RESULTS_10K,
    path: 'seq.missing',
    format: 'count',
    pattern: /patches received, ([\d,]+) observed sequence gaps/,
  },
];

/**
 * `unstated` is the vacuous-parser guard: a claim whose sentence no longer matches is a claim this
 * check silently stopped making. `mismatch` is the hazard. `unmeasured` is the results file moving
 * out from under a path — a comparison against `undefined` that would otherwise read as agreement.
 */
export type BenchGapKind = 'unstated' | 'mismatch' | 'unmeasured';

export interface BenchGap {
  readonly kind: BenchGapKind;
  readonly claim: BenchClaim;
  readonly stated?: string;
  readonly measured?: string;
}

export interface BenchInput {
  readonly claims: readonly BenchClaim[];
  /** `CLAUDE.md`, verbatim. */
  readonly prose: string;
  /** Parsed results, keyed by the same path the claims name. */
  readonly results: Readonly<Record<string, unknown>>;
}

/** `1666882` -> `1,666,882`. Written out rather than `toLocaleString`, which depends on ICU data. */
export const groupDigits = (value: number): string =>
  String(Math.trunc(Math.abs(value)))
    .split('')
    .reverse()
    .reduce<string[]>((out, digit, index) => {
      if (index > 0 && index % 3 === 0) out.push(',');
      out.push(digit);
      return out;
    }, [])
    .reverse()
    .join('');

export function renderBench(value: number, format: BenchFormat): string {
  if (format === 'seconds') return (value / 1000).toFixed(1);
  if (format === 'plain') return String(value);
  return groupDigits(value);
}

/** One number off a parsed results file, checked rather than cast — the file is data, not a type. */
export function readNumber(source: unknown, path: string): number | undefined {
  let cursor: unknown = source;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'number' ? cursor : undefined;
}

/** Pure, so the negative case is a fixture rather than an edit to CLAUDE.md or to a bench result. */
export function checkBenchClaims(input: BenchInput): readonly BenchGap[] {
  const prose = input.prose.replace(/\s+/g, ' ');
  const gaps: BenchGap[] = [];
  for (const claim of input.claims) {
    const measured = readNumber(input.results[claim.file], claim.path);
    if (measured === undefined) {
      gaps.push({ kind: 'unmeasured', claim });
      continue;
    }
    const stated = claim.pattern.exec(prose)?.[1];
    if (stated === undefined) {
      gaps.push({ kind: 'unstated', claim, measured: renderBench(measured, claim.format) });
      continue;
    }
    const rendered = renderBench(measured, claim.format);
    if (stated === rendered) continue;
    gaps.push({ kind: 'mismatch', claim, stated, measured: rendered });
  }
  return gaps;
}

const mismatchFinding = (gap: BenchGap): Finding => ({
  code: 'X_BENCH_CLAIM_STALE',
  cause: `${CLAIMS_FILE} states ${gap.stated ?? ''} for ${gap.claim.label} and ${gap.claim.file} measured ${gap.measured ?? ''}`,
  fix: `edit ${CLAIMS_FILE}: write ${gap.measured ?? ''} where it says ${gap.stated ?? ''} for ${gap.claim.label}, then bun run scripts/bench-claims.ts --json`,
  at: CLAIMS_FILE,
});

const unstatedFinding = (gap: BenchGap): Finding => ({
  code: 'X_BENCH_CLAIM_STALE',
  cause: `no sentence in ${CLAIMS_FILE} states ${gap.claim.label} any more, so this rule stopped checking ${gap.claim.file}'s ${gap.claim.path} without failing`,
  fix: `restore the sentence stating ${gap.claim.label} (${gap.measured ?? ''}) in ${CLAIMS_FILE}, or drop that claim from CLAIMS in scripts/bench-claims.ts`,
  at: CLAIMS_FILE,
});

const unmeasuredFinding = (gap: BenchGap): Finding => ({
  code: 'X_BENCH_CLAIM_STALE',
  cause: `${gap.claim.file} carries no number at ${gap.claim.path}, so ${CLAIMS_FILE}'s ${gap.claim.label} is compared against nothing`,
  fix: `point the ${gap.claim.label} entry of CLAIMS in scripts/bench-claims.ts at a key ${gap.claim.file} actually carries`,
  at: gap.claim.file,
});

const FINDINGS: Readonly<Record<BenchGapKind, (gap: BenchGap) => Finding>> = {
  mismatch: mismatchFinding,
  unstated: unstatedFinding,
  unmeasured: unmeasuredFinding,
};

export const benchGapFindingFor = (gap: BenchGap): Finding => FINDINGS[gap.kind](gap);

const readJson = async (path: string): Promise<unknown> => {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as unknown) : undefined;
};

/**
 * Read the prose and the results, then check them. The one impure step.
 *
 * A root with neither file is not this check's problem: the host checks run against synthetic trees
 * in `scripts/verify.test.ts`, and a rule that fired there would make those tests depend on files
 * they are not about.
 */
export async function benchClaimGaps(root: string): Promise<readonly BenchGap[]> {
  const prose = Bun.file(`${root}/${CLAIMS_FILE}`);
  if (!(await prose.exists())) return [];
  const files = [...new Set(CLAIMS.map((claim) => claim.file))];
  if (!(await Bun.file(`${root}/${files[0] ?? ''}`).exists())) return [];
  const loaded = await Promise.all(
    files.map(async (file) => [file, await readJson(`${root}/${file}`)] as const),
  );
  return checkBenchClaims({
    claims: CLAIMS,
    prose: await prose.text(),
    results: Object.fromEntries(loaded),
  });
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export const benchClaimFindings = async (root: string): Promise<readonly Finding[]> =>
  (await benchClaimGaps(root)).map(benchGapFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const gaps = await benchClaimGaps(repoRoot());
  report(
    {
      ok: gaps.length === 0,
      script: 'bench-claims',
      summary:
        gaps.length === 0
          ? `${CLAIMS.length} bench figures in ${CLAIMS_FILE}, every one measured by a committed result`
          : `${gaps.length} of ${CLAIMS.length} bench figures in ${CLAIMS_FILE} no longer match the results`,
      findings: gaps.map(benchGapFindingFor),
    },
    args.json,
  );
}
