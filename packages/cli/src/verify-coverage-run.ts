// An app's `unit` step, run so its coverage can be read: the suite as a pool of plain `bun test`
// processes over fixed slices, each writing its own lcov, folded by `coverage-lcov.ts`'s rule.
//
// NOT `bun test --parallel` with `--coverage` added, which is the obvious form and was measured
// first (2026-10-01, Bun 1.4.0, `examples/dummy`, 53 unit files): Bun's own cross-worker merge is
// a union, so the SAME tree read 59.9% of lines at four workers, 65.0% at two and 65.5% in one
// process. A floor that moves with the core count is not a floor. Per-process lcov folded here
// read 65.90% at 2, 4 and 8 processes.
//
// It costs nothing measurable: four slice processes took 9.7 s against 12.4 s for `--parallel=4`
// over the same files, on a loaded 12-core box.

// why: Bun ships no recursive delete and no path-join primitive; the lcov parts live under `.x/`.
import { rm } from 'node:fs/promises';
// why: Bun ships no path-join primitive.
import { dirname, join } from 'node:path';
import { ISOLATED_ENV } from '@ultimat3/testing';
import type { CoverageMap } from './coverage-lcov';
import { fileCoverageOf, mergeCoverage, parseLcov } from './coverage-lcov';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import { countsOf } from './test-counts';
import { testEnvOverrides } from './test-dotenv';
import { failureOf } from './test-shards';
import { SLOT_HELD_ENV } from './test-slots';
import type { StepOutcome } from './verify-step';

/**
 * Test files per process. Small enough that a process is thrown away before its heap grows with
 * the corpus (`test-batches.ts`), large enough that the ~0.3 s a process costs to start is noise.
 */
export const COVERAGE_SLICE_FILES = 16;

/** Where a run's lcov parts are written, under the app root — removed when the run has read them. */
export const COVERAGE_DIR = '.x/coverage';

/**
 * The slices one run is spent as: a pure function of the sorted file list, never of the machine,
 * so the measured number is the same on a laptop and on a runner. A directory's tests stay in one
 * slice — function coverage is the best one process reached (`mergeFileCoverage`), and the tests
 * that cover a file sit beside it — and only a directory larger than the cap is cut.
 */
export function coverageSlices(
  files: readonly string[],
  cap: number = COVERAGE_SLICE_FILES,
): readonly (readonly string[])[] {
  const byDir = new Map<string, string[]>();
  for (const file of [...new Set(files)].sort()) {
    const dir = dirname(file);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const slices: string[][] = [];
  let open: string[] = [];
  const close = (): void => {
    if (open.length > 0) slices.push(open);
    open = [];
  };
  for (const group of byDir.values()) {
    if (group.length > cap) {
      close();
      for (let at = 0; at < group.length; at += cap) slices.push(group.slice(at, at + cap));
    } else {
      if (open.length + group.length > cap) close();
      open.push(...group);
    }
  }
  close();
  return slices;
}

export interface CoveredRunOptions {
  readonly root: string;
  readonly runner: Runner;
  /** Paths relative to `root`. */
  readonly files: readonly string[];
  readonly workers: number;
  readonly isolate?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly widthReason?: string;
  readonly lease?: (want: number) => Promise<{ readonly count: number; release(): void }>;
  /** Test files per process. Absent is `COVERAGE_SLICE_FILES`; a test cuts smaller. */
  readonly sliceFiles?: number;
}

export interface CoveredRun extends StepOutcome {
  /** Every file any slice loaded, by the path Bun wrote — relative to `root`. */
  readonly coverage: CoverageMap;
}

/** One slice's argv. An explicit file list, never a re-glob, for `testArgs`' reason. */
export const coveredArgs = (
  files: readonly string[],
  dir: string,
  isolate: boolean,
): readonly string[] => [
  'bun',
  'test',
  ...(isolate ? ['--isolate'] : []),
  '--coverage',
  '--coverage-reporter=lcov',
  `--coverage-dir=${dir}`,
  ...files,
];

export async function runCovered(options: CoveredRunOptions): Promise<CoveredRun> {
  const slices = coverageSlices(options.files, options.sliceFiles);
  const want = Math.max(1, Math.min(Math.trunc(options.workers), slices.length));
  const lease = want > 1 ? await options.lease?.(want) : undefined;
  const width = Math.min(want, lease?.count ?? want);
  const base = join(options.root, COVERAGE_DIR, `unit-${String(process.pid)}`);
  const isolate = options.isolate === true;
  const overrides = {
    ...testEnvOverrides(options.root, options.env ?? Bun.env),
    ...(isolate ? { [ISOLATED_ENV]: '1' } : {}),
    ...(lease === undefined ? {} : { [SLOT_HELD_ENV]: '1' }),
  };
  const results = new Array<ExecResult>(slices.length);
  let next = 0;
  // Each pool worker names its own numbered test database, as `--parallel`'s workers do.
  const worker = async (slot: number): Promise<void> => {
    while (next < slices.length) {
      const index = next;
      next += 1;
      results[index] = await options.runner(
        coveredArgs(slices[index] as readonly string[], join(base, String(index)), isolate),
        { cwd: options.root, env: { ...overrides, ULTIMATE_TEST_WORKER: String(slot) } },
      );
    }
  };
  let maps: CoverageMap[];
  try {
    await Promise.all(Array.from({ length: width }, (_, slot) => worker(slot)));
    maps = await Promise.all(slices.map((_, index) => readPart(join(base, String(index)))));
  } finally {
    lease?.release();
    await rm(base, { recursive: true, force: true });
  }
  const failed = results.filter((result) => !result.ok);
  const first = failed[0];
  const output = results
    .map((result, index) =>
      result.ok
        ? undefined
        : [
            msg('cli.test.batch', {
              batch: index + 1,
              batches: results.length,
              files: slices[index]?.length ?? 0,
            }),
            execOutput(result),
          ].join('\n'),
    )
    .filter((text) => text !== undefined)
    .join('\n');
  return {
    ok: first === undefined,
    findings:
      first === undefined
        ? []
        : [
            failureOf(first.code, options.files.length, {
              workers: width,
              type: 'unit',
              ...(isolate ? { isolate: true } : {}),
            }),
          ],
    workers: width,
    ...(options.widthReason === undefined ? {} : { widthReason: options.widthReason }),
    tests: countsOf(results),
    ...(first === undefined ? {} : { output }),
    coverage: mergeCoverage(maps),
  };
}

/**
 * One slice's lcov as a map, kept to the app's own tree: a slice loads a thousand framework files
 * for every hundred of the app's, and none of those is what the floor measures. No file is no
 * coverage — the slice died before writing it, and its exit code already says so.
 */
async function readPart(dir: string): Promise<CoverageMap> {
  const file = Bun.file(join(dir, 'lcov.info'));
  if (!(await file.exists())) return {};
  return Object.fromEntries(
    parseLcov(await file.text())
      .filter((record) => /^(?:apps|packages)\//.test(record.file))
      .map((record) => [record.file, fileCoverageOf(record)]),
  );
}
