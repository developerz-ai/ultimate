#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, that the realtime capacity figures
// `scripts/bench/results/README.md` states are the figures the committed bench results carry.
// Nothing compared the two, so a re-run that moved a percentile — or a hand-edited sentence — left
// the repo's loudest measured claim describing a run that never happened. The prose lived in root
// `CLAUDE.md` until 2026-09-23 and moved beside the results it describes.
//
//   bun run scripts/bench-claims.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { BenchClaim, BenchFormat } from './lib/bench-claims-table';
import { CLAIMS, CLAIMS_FILE } from './lib/bench-claims-table';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export type { BenchClaim, BenchFormat } from './lib/bench-claims-table';
export {
  CLAIMS,
  CLAIMS_FILE,
  COMPARED,
  RESULTS_10K,
  RESULTS_50K,
  RESULTS_FIRST_HOUR,
  RESULTS_HTTP_HOME,
  RESULTS_HTTP_QUERY,
  RESULTS_RENDER,
} from './lib/bench-claims-table';

/**
 * `unstated` is the vacuous-parser guard: a claim whose sentence no longer matches is a claim this
 * check silently stopped making. `mismatch` is the hazard. `unmeasured` is the results file moving
 * out from under a path — a comparison against `undefined` that would otherwise read as agreement.
 * `absent` is both files gone: root `CLAUDE.md` links the claims page, so a tree without it is a
 * tree that lost its measurements, never one that makes no claims.
 */
export type BenchGapKind = 'unstated' | 'mismatch' | 'unmeasured' | 'absent';

export interface BenchGap {
  readonly kind: BenchGapKind;
  readonly claim: BenchClaim;
  readonly stated?: string;
  readonly measured?: string;
}

export interface BenchInput {
  readonly claims: readonly BenchClaim[];
  /** `CLAIMS_FILE`, verbatim. */
  readonly prose: string;
  /** Every other page a claim names in `doc`, verbatim, keyed by that path. */
  readonly docs?: Readonly<Record<string, string>>;
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

/**
 * THE ROUNDING CONVENTION, decided here because the prose was ambiguous, and stated beside the code
 * that implements it rather than in a header: a duration renders as `(ms / 1000).toFixed(1)` seconds
 * — 53951ms is `54.0s` — and a count with `,` every three digits. Nothing else is accepted. A value
 * landing exactly on a `.x5` boundary settles by `toFixed`, so a mismatch finding always carries the
 * string to write instead of asking an author for a decision.
 */
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
  const collapse = (text: string): string => text.replace(/\s+/g, ' ');
  const docs = new Map(
    Object.entries(input.docs ?? {}).map(([doc, text]) => [doc, collapse(text)]),
  );
  const main = collapse(input.prose);
  const gaps: BenchGap[] = [];
  for (const claim of input.claims) {
    const prose = claim.doc === undefined ? main : (docs.get(claim.doc) ?? '');
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

/** The page a claim is stated on. */
const pageOf = (claim: BenchClaim): string => claim.doc ?? CLAIMS_FILE;

const mismatchFinding = (gap: BenchGap): Finding => ({
  code: 'X_BENCH_CLAIM_STALE',
  cause: `${pageOf(gap.claim)} states ${gap.stated ?? ''} for ${gap.claim.label} and ${gap.claim.file} measured ${gap.measured ?? ''}`,
  fix: `bun run scripts/bench-claims.ts --json   # after editing ${pageOf(gap.claim)}: write ${gap.measured ?? ''} where it says ${gap.stated ?? ''} for ${gap.claim.label}`,
  at: pageOf(gap.claim),
});

const unstatedFinding = (gap: BenchGap): Finding => ({
  code: 'X_BENCH_CLAIM_STALE',
  cause: `no sentence in ${pageOf(gap.claim)} states ${gap.claim.label} any more, so this rule stopped checking ${gap.claim.file}'s ${gap.claim.path} without failing`,
  fix: `restore the sentence stating ${gap.claim.label} (${gap.measured ?? ''}) in ${pageOf(gap.claim)}, or drop that claim from CLAIMS in scripts/bench-claims.ts`,
  at: pageOf(gap.claim),
});

const unmeasuredFinding = (gap: BenchGap): Finding => ({
  code: 'X_BENCH_CLAIM_STALE',
  cause: `${gap.claim.file} carries no number at ${gap.claim.path}, so ${CLAIMS_FILE}'s ${gap.claim.label} is compared against nothing`,
  fix: `point the ${gap.claim.label} entry of CLAIMS in scripts/bench-claims.ts at a key ${gap.claim.file} actually carries`,
  at: gap.claim.file,
});

const absentFinding = (gap: BenchGap): Finding => ({
  code: 'X_BENCH_CLAIM_STALE',
  cause: `neither ${CLAIMS_FILE} nor ${gap.claim.file} exists, and root CLAUDE.md links ${CLAIMS_FILE} as where realtime capacity is measured — so the ${gap.claim.label} is checked against nothing`,
  // A literal directory, not the two constants spliced in: both live under it, and a fix's command
  // position takes no interpolated value (`fix-shell-arg`).
  fix: 'git checkout origin/main -- scripts/bench/results/   # then bun run scripts/bench-claims.ts --json',
  at: CLAIMS_FILE,
});

const FINDINGS: Readonly<Record<BenchGapKind, (gap: BenchGap) => Finding>> = {
  mismatch: mismatchFinding,
  unstated: unstatedFinding,
  unmeasured: unmeasuredFinding,
  absent: absentFinding,
};

export const benchGapFindingFor = (gap: BenchGap): Finding => FINDINGS[gap.kind](gap);

const readJson = async (path: string): Promise<unknown> => {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as unknown) : undefined;
};

/**
 * Read the prose and the results, then check them. The one impure step.
 *
 * No combination of files on disk is silent — each used to suppress the whole rule:
 *
 * | On disk | Was | Is |
 * |---|---|---|
 * | results deleted, prose kept | green — the figures were compared against nothing | `unmeasured` per claim |
 * | prose deleted, results kept | green — every anchored pattern matched nothing | `unstated` per claim |
 * | both deleted | green — "not a tree that makes these claims" | `absent` per claim |
 *
 * The first is the state a re-run passes through, which is the exact moment the numbers are least
 * trustworthy. The third was argued as "nothing to check", but this rule runs on THIS repo's gate
 * only (`frameworkFiles` in `scripts/verify.ts`) and root `CLAUDE.md` links the claims page — a
 * tree without it lost its measurements, it did not stop making them.
 */
export async function benchClaimGaps(root: string): Promise<readonly BenchGap[]> {
  const prose = Bun.file(`${root}/${CLAIMS_FILE}`);
  const files = [...new Set(CLAIMS.map((claim) => claim.file))];
  const loaded = await Promise.all(
    files.map(async (file) => [file, await readJson(`${root}/${file}`)] as const),
  );
  const proseExists = await prose.exists();
  if (!proseExists && loaded.every(([, body]) => body === undefined)) {
    return CLAIMS.map((claim) => ({ kind: 'absent', claim }));
  }
  const pages = [
    ...new Set(CLAIMS.flatMap((claim) => (claim.doc === undefined ? [] : [claim.doc]))),
  ];
  const docs = await Promise.all(
    pages.map(async (doc) => {
      const page = Bun.file(`${root}/${doc}`);
      return [doc, (await page.exists()) ? await page.text() : ''] as const;
    }),
  );
  return checkBenchClaims({
    claims: CLAIMS,
    prose: proseExists ? await prose.text() : '',
    docs: Object.fromEntries(docs),
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
          ? `${CLAIMS.length} bench figures in ${CLAIMS_FILE} and the pages citing them, every one measured by a committed result`
          : `${gaps.length} of ${CLAIMS.length} bench figures no longer match the results`,
      findings: gaps.map(benchGapFindingFor),
    },
    args.json,
  );
}
