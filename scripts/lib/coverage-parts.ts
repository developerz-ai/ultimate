// A unit too heavy for one runner, measured as PARTS: how many, which of its test files each runs,
// a part's coverage as it crosses runners, and the fold of the parts back into one lcov the gate
// reads exactly as it reads a whole unit's. Planning and data only — the runs and the verdict are
// `scripts/coverage-gate.ts`'s.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { CoverageMap, CoverageWire } from '../../packages/cli/src/coverage-lcov';
import {
  decodeCoverage,
  encodeCoverage,
  fileCoverageOf,
  mergeCoverage,
  parseLcov,
} from '../../packages/cli/src/coverage-lcov';
import { quoteArg } from '../../packages/cli/src/shell-quote';
import { corpusHash } from '../../packages/cli/src/verify-shard';
import { E2E_PATH_GLOBS } from '../../packages/cli/src/verify-tests';
import type { Finding } from './log';

/**
 * Test-file milliseconds one part may carry, in the committed `scripts/lib/ci/test-weights.json`'s
 * units (the gate's `unit` step on a CI runner, no coverage). A unit over it is cut into
 * `ceil(weight / PART_MS)` parts, each a `bun test` of its own on its own `packages` runner, so the
 * cut follows the suite as it grows and no one edits a number to keep up.
 *
 * 800 s, because coverage costs ~1.26× the weights on a runner (`cli`: 1461 s of weights, 1844
 * core-seconds measured, 2026-11-17), so a full part is ~1000 core-seconds — ~250-270 s on the
 * four workers it leases, under the five-minute target with the job's setup.
 */
export const PART_MS = 800_000;

/** Where a shard leaves the parts it measured for `--merge`, root-relative. */
export const PARTS_DIR = '.x/coverage-parts';

/** One part of a unit: 1-based, and the files `bun test` is handed for it. */
export interface UnitPart {
  readonly unit: string;
  readonly index: number;
  readonly total: number;
  readonly files: readonly string[];
}

/** `cli#1/2` — how a part is named in a shard's list, a report line and a finding. */
export const partName = (part: Pick<UnitPart, 'unit' | 'index' | 'total'>): string =>
  `${part.unit}#${String(part.index)}/${String(part.total)}`;

/** The unit a scheduled name measures: `cli#1/2` → `cli`; a whole unit's name is its own. */
export const unitOfName = (name: string): string => name.split('#')[0] as string;

const E2E = E2E_PATH_GLOBS.map((glob) => new Bun.Glob(glob));

/** The test files a unit's coverage run executes: what `bun test` finds, less every e2e path. */
export const coverageFiles = (found: readonly string[]): readonly string[] =>
  found.filter((file) => !E2E.some((glob) => glob.match(file))).sort();

/** What a file costs: its measured ms, or the median of the unit's measured files. */
function costs(files: readonly string[], weights: Readonly<Record<string, number>>) {
  const known = files
    .map((file) => (Object.hasOwn(weights, file) ? weights[file] : undefined))
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const median = known.length === 0 ? 1 : (known[Math.floor(known.length / 2)] as number);
  return (file: string): number => {
    const ms = Object.hasOwn(weights, file) ? weights[file] : undefined;
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : median;
  };
}

/**
 * A unit's test files cut into parts by WEIGHT BAND: heaviest first, part 1 filled to its share of
 * the total, then part 2, and so on — so the last part is the many light files. Not
 * longest-processing-time, which balances as well and mixes every band into every part.
 *
 * The band is what keeps the folded function count honest. Bun's lcov counts a file's functions
 * (`FNF`/`FNH`) but names none, so across processes a file keeps the best part's count, a lower
 * bound (`mergeFileCoverage`). The light band is the unit tests, which reach almost every function
 * a heavy suite does; dealt round the parts instead, two parts each hit half a file's functions.
 * Measured on `cli`, 2026-11-17, whole 7699/8083 functions: banded 7665 (−34), longest-first 7606
 * (−93). Lines fold exactly either way (61805 → 61809 / 61796 of 63978).
 */
export function planParts(
  unit: string,
  files: readonly string[],
  weights: Readonly<Record<string, number>>,
  partMs: number = PART_MS,
): readonly UnitPart[] {
  const sorted = [...new Set(files)].sort();
  const cost = costs(sorted, weights);
  const total = sorted.reduce((sum, file) => sum + cost(file), 0);
  const count = Math.max(1, Math.ceil(total / partMs));
  const bands: string[][] = Array.from({ length: count }, () => []);
  // A stable sort over the sorted list: equal costs keep path order, so one tree cuts one way.
  const order = [...sorted].sort((a, b) => cost(b) - cost(a));
  let band = 0;
  let filled = 0;
  for (const file of order) {
    (bands[band] as string[]).push(file);
    filled += cost(file);
    if (band < count - 1 && filled >= (total * (band + 1)) / count) band += 1;
  }
  // A file heavier than a share fills a band and more, so the last bands can be left empty.
  const filledBands = bands.filter((one) => one.length > 0);
  return filledBands.map((one, at) => ({
    unit,
    index: at + 1,
    total: filledBands.length,
    files: one.sort(),
  }));
}

/** What a shard hands `--merge` for one part: its coverage, scoped to the unit's own source. */
export interface PartDocument {
  readonly unit: string;
  readonly index: number;
  readonly total: number;
  /** `corpusHash` of the part's files: a part cut from another tree's plan is refused. */
  readonly deal: string;
  readonly seconds: number;
  readonly workers: number;
  readonly coverage: CoverageWire;
}

/** The file a part's document is written to, under `PARTS_DIR`. */
export const partFile = (part: Pick<UnitPart, 'unit' | 'index' | 'total'>): string =>
  `${part.unit}.${String(part.index)}-of-${String(part.total)}.json`;

/** An lcov report's records `own` keeps, as a coverage map — what a part document carries. */
export function ownCoverage(lcov: string, own: (file: string) => boolean): CoverageMap {
  return Object.fromEntries(
    parseLcov(lcov)
      .filter((record) => own(record.file))
      .map((record) => [record.file, fileCoverageOf(record)]),
  );
}

export const partDocument = (
  part: UnitPart,
  coverage: CoverageMap,
  run: { readonly seconds: number; readonly workers: number },
): PartDocument => ({
  unit: part.unit,
  index: part.index,
  total: part.total,
  deal: corpusHash(part.files),
  seconds: run.seconds,
  workers: run.workers,
  coverage: encodeCoverage(coverage),
});

/** A document read back off disk, or `undefined` when it is not one. */
export function readPartDocument(raw: unknown): PartDocument | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const doc = raw as Record<string, unknown>;
  const { unit, index, total, deal, seconds, workers, coverage } = doc;
  if (typeof unit !== 'string' || typeof deal !== 'string') return undefined;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total)) return undefined;
  if (typeof seconds !== 'number' || typeof workers !== 'number') return undefined;
  if (decodeCoverage(coverage) === undefined) return undefined;
  return { unit, index, total, deal, seconds, workers, coverage } as PartDocument;
}

/**
 * Every part document under `dir`, at any depth (one artifact directory per shard), newest first:
 * paths are read in sorted order, so a re-run's `…-attempt-2/` is ahead of `…-attempt-1/` and
 * `foldParts` takes it. A directory that is not there holds none, which the fold names.
 */
export async function readParts(dir: string): Promise<readonly PartDocument[]> {
  let paths: string[];
  try {
    paths = [...new Bun.Glob('**/*.json').scanSync({ cwd: dir })].sort();
  } catch {
    return [];
  }
  const docs: PartDocument[] = [];
  for (const path of paths) {
    let raw: unknown;
    try {
      raw = await Bun.file(join(dir, path)).json();
    } catch {
      continue;
    }
    const doc = readPartDocument(raw);
    if (doc !== undefined) docs.unshift(doc);
  }
  return docs;
}

/** A coverage map as the lcov Bun writes: what a whole unit's reading is computed from. */
export function renderLcov(map: CoverageMap): string {
  const out: string[] = [];
  for (const [file, one] of Object.entries(map)) {
    const lines = [
      ...one.hit.map((line) => [line, 1] as const),
      ...one.miss.map((line) => [line, 0] as const),
    ].sort((a, b) => a[0] - b[0]);
    out.push(`SF:${file}`, `FNF:${String(one.funcsFound)}`, `FNH:${String(one.funcsHit)}`);
    for (const [line, hits] of lines) out.push(`DA:${String(line)},${String(hits)}`);
    out.push(`LF:${String(lines.length)}`, `LH:${String(one.hit.length)}`, 'end_of_record');
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** Every part of `plan` folded into one lcov, or why the unit cannot be read from what reported. */
export function foldParts(
  plan: readonly UnitPart[],
  docs: readonly PartDocument[],
): { readonly lcov: string; readonly seconds: number; readonly workers: number } | Finding {
  const maps: CoverageMap[] = [];
  let seconds = 0;
  let workers = 0;
  for (const part of plan) {
    const doc = docs.find((one) => one.unit === part.unit && one.index === part.index);
    // The plan's identity, not a secret: a part cut from another tree's file list is refused.
    const plannedDeal = corpusHash(part.files);
    const fresh = doc !== undefined && doc.total === part.total;
    if (!fresh || doc.deal !== plannedDeal) {
      return {
        code: 'X_COVERAGE_UNMEASURED',
        cause: !fresh
          ? `part ${partName(part)} never reported its coverage, so ${part.unit}'s reading would be a fraction of its suite`
          : `part ${partName(part)} reported coverage for another set of test files than this tree deals it, so the fold would mix two trees`,
        fix: `bun run scripts/coverage-gate.ts --package ${quoteArg(part.unit)} --json   # every part on this machine, folded; on CI the shard that ran ${partName(part)} names why it wrote nothing to ${PARTS_DIR}`,
      };
    }
    maps.push(decodeCoverage(doc.coverage) ?? {});
    seconds = Math.max(seconds, doc.seconds);
    workers += doc.workers;
  }
  return { lcov: renderLcov(mergeCoverage(maps)), seconds, workers };
}
