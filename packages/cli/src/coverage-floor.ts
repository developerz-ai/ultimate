// The coverage floor an app states in `x.verify.json`, what the unit suite measured against the
// app's WHOLE source tree, and the findings where the two disagree. A finding of the `unit` step,
// never a step of its own: the step list is as stable as an error code.

// why: Bun ships no synchronous existence check and no path-join primitive; the fix a
// below-floor finding carries depends on whether the test beside the worst file exists.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { CoverageMap } from './coverage-lcov';
import { percent } from './coverage-lcov';
import { appSourceFiles, hasExecutableCode, readSource, unloadedWeight } from './coverage-source';
import { msg } from './messages';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** The `x.verify.json` key. */
export const COVERAGE_FIELD = 'coverage';

/**
 * Lines and functions, the framework's own code and every app's — one bar. **A floor, not the
 * goal**: coverage measures execution, not validation, and a test added to raise it is proven by
 * mutation (break the source, watch it go red, restore). A covered branch whose test cannot fail
 * is worse than an uncovered one.
 */
export const COVERAGE_BAR = 95;

/** How far above a floor under the bar the tree may measure before the floor has to rise. */
export const FLOOR_SLACK = 1.5;

/** How many files a below-floor finding names. */
export const LOSS_LIMIT = 10;

const FLOOR_FILE = 'x.verify.json';

export interface CoverageExclude {
  /** Relative to the app root. */
  readonly glob: string;
  /** Why a unit test cannot execute it — a browser-only mount, a container entry point. */
  readonly why: string;
}

export interface CoverageFloor {
  readonly lines: number;
  readonly funcs: number;
  /** Required while either number is under `COVERAGE_BAR`: what is uncovered, who closes it. */
  readonly why?: string;
  readonly exclude: readonly CoverageExclude[];
}

const isPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * `coverage` out of `x.verify.json`, or the reasons it is not a floor. A number that is not a
 * percentage is refused rather than read as zero — `measured < NaN` is false for every reading,
 * so a typo would stop the floor enforcing and report green. An `exclude` entry with no `why` is
 * refused too, and DROPPED: it excludes nothing until it says what it is for.
 */
export function readCoverageFloor(payload: Record<string, unknown> | undefined): {
  coverage?: CoverageFloor;
  problems: readonly string[];
} {
  const raw = payload?.[COVERAGE_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problems: [`"${COVERAGE_FIELD}" is not an object of { "lines", "funcs" }`] };
  }
  const record = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ['lines', 'funcs'] as const) {
    if (!isPercent(record[key])) {
      problems.push(
        `"${COVERAGE_FIELD}.${key}" is ${JSON.stringify(record[key])}, which is not a percentage from 0 to 100`,
      );
    }
  }
  if (record['why'] !== undefined && !isText(record['why'])) {
    problems.push(`"${COVERAGE_FIELD}.why" is not a sentence`);
  }
  const exclude: CoverageExclude[] = [];
  const list = record['exclude'];
  if (list !== undefined && !Array.isArray(list)) {
    problems.push(`"${COVERAGE_FIELD}.exclude" is not a list of { "glob", "why" }`);
  }
  for (const entry of Array.isArray(list) ? (list as unknown[]) : []) {
    const one =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    if (!isText(one['glob'])) {
      problems.push(`"${COVERAGE_FIELD}.exclude" holds an entry with no "glob"`);
    } else if (!isText(one['why'])) {
      problems.push(
        `"${COVERAGE_FIELD}.exclude" excludes ${one['glob']} with no "why" — say why a unit test cannot execute it`,
      );
    } else exclude.push({ glob: one['glob'], why: one['why'] });
  }
  if (!isPercent(record['lines']) || !isPercent(record['funcs'])) return { problems };
  return {
    coverage: {
      lines: record['lines'],
      funcs: record['funcs'],
      ...(isText(record['why']) ? { why: record['why'] } : {}),
      exclude,
    },
    problems,
  };
}

/** One source file's share of the gap. */
export interface FileLoss {
  readonly file: string;
  /** Lines that could have run and did not. */
  readonly uncovered: number;
  readonly lines: number;
  /** No unit test loaded it at all: it counts at 0%, weighed off its source. */
  readonly unloaded: boolean;
}

export interface CoverageMeasure {
  readonly lines: number;
  readonly funcs: number;
  readonly linesHit: number;
  readonly linesFound: number;
  readonly funcsHit: number;
  readonly funcsFound: number;
  /** Source files counted, loaded or not. */
  readonly files: number;
  /** Worst first: most uncovered lines, then by path. */
  readonly losses: readonly FileLoss[];
}

/**
 * The suite's coverage of the app's WHOLE source tree. `coverage` is keyed by path relative to
 * `root`; a record for anything else — a framework package, `node_modules`, a test — is not the
 * app's source and is dropped. A source file with executable code and no record counts at 0%.
 */
export async function measureCoverage(
  root: string,
  coverage: CoverageMap,
  floor: CoverageFloor | undefined,
): Promise<CoverageMeasure> {
  const sources = appSourceFiles(root, floor?.exclude.map((entry) => entry.glob) ?? []);
  let linesHit = 0;
  let linesFound = 0;
  let funcsHit = 0;
  let funcsFound = 0;
  let files = 0;
  const losses: FileLoss[] = [];
  for (const file of sources) {
    const loaded = Object.hasOwn(coverage, file) ? coverage[file] : undefined;
    if (loaded !== undefined) {
      const found = loaded.hit.length + loaded.miss.length;
      linesHit += loaded.hit.length;
      linesFound += found;
      funcsHit += Math.min(loaded.funcsHit, loaded.funcsFound);
      funcsFound += loaded.funcsFound;
      files += 1;
      if (loaded.miss.length > 0) {
        losses.push({ file, uncovered: loaded.miss.length, lines: found, unloaded: false });
      }
      continue;
    }
    const source = await readSource(root, file);
    // A barrel or a types-only module emits nothing, so Bun writes no record for it when it IS
    // loaded: absent is correct, and it weighs nothing.
    if (source === undefined || !hasExecutableCode(source)) continue;
    const weight = unloadedWeight(source);
    linesFound += weight.lines;
    funcsFound += weight.funcs;
    files += 1;
    losses.push({ file, uncovered: weight.lines, lines: weight.lines, unloaded: true });
  }
  losses.sort((a, b) => b.uncovered - a.uncovered || (a.file < b.file ? -1 : 1));
  return {
    lines: percent(linesHit, linesFound),
    funcs: percent(funcsHit, funcsFound),
    linesHit,
    linesFound,
    funcsHit,
    funcsFound,
    files,
    losses,
  };
}

/** One decimal, rounded DOWN: a printed number never claims more than was measured. */
const shown = (value: number): string => (Math.floor(value * 10) / 10).toFixed(1);

/**
 * The floor a measured number supports: the bar once it clears it, the whole number under it
 * below — up to a point of room, so one uncovered line in an unrelated file is not a red gate,
 * and less than `FLOOR_SLACK`, so the floor it writes is never stale the moment it is written.
 */
const floorFor = (measured: number): number =>
  measured >= COVERAGE_BAR ? COVERAGE_BAR : Math.floor(measured);

const WHY_PLACEHOLDER = '<what is uncovered and who closes it>';

/** The `"coverage": { … }` text for a measured tree — what an author pastes. */
export function floorLine(measure: Pick<CoverageMeasure, 'lines' | 'funcs'>): string {
  const lines = floorFor(measure.lines);
  const funcs = floorFor(measure.funcs);
  const why = lines < COVERAGE_BAR || funcs < COVERAGE_BAR ? `, "why": "${WHY_PLACEHOLDER}"` : '';
  return `"${COVERAGE_FIELD}": { "lines": ${String(lines)}, "funcs": ${String(funcs)}${why} }`;
}

/**
 * `foo.ts` → `foo.test.ts`, and `page.tsx` → `page.test.ts`: where the test that covers a file
 * lives. Always `.ts` — every generator writes it so, and a test holds no JSX: the registry leak
 * guard's loader covers `.test.ts` only, so a `.test.tsx` this named would also be unguarded.
 */
export const testPathOf = (file: string): string => file.replace(/\.tsx?$/, '.test.ts');

export interface JudgeOptions {
  /** Whether `path` (relative to the app root) exists — decides which fix a below-floor gets. */
  readonly exists: (path: string) => boolean;
}

/**
 * The findings a measurement earns against the stated floor — none is the only pass.
 *
 * | State | Finding |
 * |---|---|
 * | no floor stated | `X_COVERAGE_FLOOR_UNSTATED`, carrying the line to add |
 * | a floor under the bar with no `why` | `X_COVERAGE_FLOOR_UNSTATED` |
 * | measured under the floor | `X_COVERAGE_BELOW_FLOOR`, naming the files that lose the most |
 * | a floor under the bar, and the tree `FLOOR_SLACK` points over it | `X_COVERAGE_FLOOR_STALE` |
 *
 * The last row is what makes the floor only rise, and it needs no history to do it: a floor may
 * sit under the bar only while it is what the tree measures.
 */
export function coverageFindings(
  measure: CoverageMeasure,
  floor: CoverageFloor | undefined,
  options: JudgeOptions,
): readonly Finding[] {
  const measured = `${shown(measure.lines)}% of lines and ${shown(measure.funcs)}% of functions`;
  if (floor === undefined) {
    return [
      {
        code: 'X_COVERAGE_FLOOR_UNSTATED',
        cause: `${FLOOR_FILE} states no coverage floor; the unit suite covers ${measured} of this app's own source (${String(measure.files)} files, one no test loads counted at 0%)`,
        fix: `edit ${FLOOR_FILE} — add ${floorLine(measure)}`,
        docs: ERROR_DOCS_URL,
        at: FLOOR_FILE,
      },
    ];
  }
  const findings: Finding[] = [];
  const stated = `${shown(floor.lines)}% / ${shown(floor.funcs)}%`;
  const underBar = floor.lines < COVERAGE_BAR || floor.funcs < COVERAGE_BAR;
  if (underBar && floor.why === undefined) {
    findings.push({
      code: 'X_COVERAGE_FLOOR_UNSTATED',
      cause: `${FLOOR_FILE} states a coverage floor of ${stated}, under the ${String(COVERAGE_BAR)}% bar, and no reason for it`,
      fix: `edit ${FLOOR_FILE} — add "why": "${WHY_PLACEHOLDER}" inside "${COVERAGE_FIELD}", or raise both numbers to ${String(COVERAGE_BAR)}`,
      docs: ERROR_DOCS_URL,
      at: FLOOR_FILE,
    });
  }
  if (measure.lines < floor.lines || measure.funcs < floor.funcs) {
    const worst = measure.losses.slice(0, LOSS_LIMIT);
    const named = worst
      .map((loss) =>
        loss.unloaded
          ? `${loss.file} (no unit test loads it: ${String(loss.lines)} lines)`
          : `${loss.file} (${String(loss.uncovered)} of ${String(loss.lines)} lines)`,
      )
      .join(', ');
    const first = worst[0];
    const test = first === undefined ? undefined : testPathOf(first.file);
    findings.push({
      code: 'X_COVERAGE_BELOW_FLOOR',
      cause: `the unit suite covers ${measured} of this app's own source, under the floor of ${stated} in ${FLOOR_FILE}${named === '' ? '' : ` — losing the most lines: ${named}`}`,
      fix:
        test === undefined
          ? 'x verify --only unit --json'
          : options.exists(test)
            ? // Quoted: a route directory is `[id]`, which a shell reads as a glob.
              `bun test --coverage ${quoteArg(test)}`
            : `edit ${test} — no test sits beside ${first?.file ?? test}; write one that fails when the source is broken, then: bun test --coverage ${quoteArg(test)}`,
      docs: ERROR_DOCS_URL,
      ...(first === undefined ? {} : { at: first.file }),
    });
  }
  const risen = (['lines', 'funcs'] as const).filter(
    (key) => floor[key] < COVERAGE_BAR && measure[key] >= floor[key] + FLOOR_SLACK,
  );
  if (risen.length > 0) {
    const lines = Math.max(floor.lines, floorFor(measure.lines));
    const funcs = Math.max(floor.funcs, floorFor(measure.funcs));
    const cleared = lines >= COVERAGE_BAR && funcs >= COVERAGE_BAR;
    findings.push({
      code: 'X_COVERAGE_FLOOR_STALE',
      cause: `the unit suite now covers ${measured}, more than ${String(FLOOR_SLACK)} points over the floor of ${stated} in ${FLOOR_FILE} — the floor only rises`,
      fix: `edit ${FLOOR_FILE} — set "lines": ${String(lines)} and "funcs": ${String(funcs)} inside "${COVERAGE_FIELD}"${cleared ? ', and delete its "why"' : ''}`,
      docs: ERROR_DOCS_URL,
      at: FLOOR_FILE,
    });
  }
  return findings;
}

export interface CoverageVerdict {
  readonly measure: CoverageMeasure;
  readonly findings: readonly Finding[];
  /** One line for the step's `output`: the numbers, and the floor they were held to. */
  readonly output: string;
}

/** Measure `coverage` against the app at `root` and judge it against `floor` — the whole check. */
export async function judgeCoverage(
  root: string,
  coverage: CoverageMap,
  floor: CoverageFloor | undefined,
): Promise<CoverageVerdict> {
  const measure = await measureCoverage(root, coverage, floor);
  return {
    measure,
    findings: coverageFindings(measure, floor, {
      exists: (path) => existsSync(join(root, path)),
    }),
    output: msg('cli.verify.coverage', {
      lines: shown(measure.lines),
      funcs: shown(measure.funcs),
      files: measure.files,
      floor: floor === undefined ? 'unstated' : `${shown(floor.lines)}% / ${shown(floor.funcs)}%`,
    }),
  };
}
