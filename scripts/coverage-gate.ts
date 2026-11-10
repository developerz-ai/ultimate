#!/usr/bin/env bun
// Enforce, per unit, that a unit's own source is covered by its own tests. A unit is one package
// (`packages/<name>/src/`) or `scripts/` — this repo's own guards and tooling.
//
// Scoped deliberately. `bun test packages/<pkg>` loads every package that one imports, and Bun's
// summary row averages over ALL of them — so `@ultimat3/cache` read 35% while its own sources were
// at 98.8%, the difference being tier-0 and tier-1 files its tests never exercise. A number that
// wrong in that direction is worse than none: it reads as a crisis nobody can act on, and it moves
// when an unrelated package grows.
//
//   bun run scripts/coverage-gate.ts --package core [--json]
//   bun run scripts/coverage-gate.ts --package scripts [--json]
//   bun run scripts/coverage-gate.ts --all [--jobs <n>] [--shard i/n] [--json]
//
// `--shard i/n` is one CI runner's share of `--all`, dealt by each unit's measured core-seconds
// (`UNIT_SECONDS`), so shard 1/2 is the same units on every runner. The lcov reader is the CLI's (`coverage-lcov.ts`),
// the one an app's `x verify` reads its own floor through.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { finiteOption } from '@ultimat3/core';
import { parseLcov, percent } from '../packages/cli/src/coverage-lcov';
import { hasExecutableCode, TEST_FILE, unloadedWeight } from '../packages/cli/src/coverage-source';
import { BadFlagError } from '../packages/cli/src/errors';
import { E2E_PATH_GLOBS } from '../packages/cli/src/verify-tests';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { CoveragePin } from './lib/coverage-pins';
import {
  COVERAGE_EXCLUDED,
  COVERAGE_PINS,
  COVERAGE_TARGET,
  PIN_SLACK,
  PINS_FILE,
} from './lib/coverage-pins';
import { concurrency, leasePool, serviceKeys, unitEnv, workersFor } from './lib/coverage-schedule';
import type { CoverageUnit } from './lib/coverage-units';
import { atOf, SCRIPTS_UNIT, testFileCount, unitOf, unitsFor } from './lib/coverage-units';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

export interface CoverageReading {
  /** The unit's name — a package, or `scripts`. */
  readonly pkg: string;
  readonly lines: number;
  readonly funcs: number;
  /** Lines found in the unit's own source. Zero is the false green this gate refuses. */
  readonly measured: number;
  /**
   * Source files with executable code that lcov has no record of at all. They are NOT zeroes in
   * the percentage — bun records a file only when something imports it, so a module no test
   * reaches is absent from both halves of the fraction and silently makes the number BETTER.
   * `@ultimat3/ui` had 16 of these, and its denominator grew from 2,922 to 3,286 lines the day
   * they were first imported.
   */
  readonly unimported: readonly string[];
  /** Wall seconds the unit's suite took alone — what a `--shard` split is balanced by. */
  readonly seconds?: number;
  /** `bun test` workers the unit ran on — one is a single process (`testCommand`). */
  readonly workers?: number;
}

/**
 * One unit's verdict. `required` is what it had to clear — the target, or its pin.
 */
export interface CoverageVerdict {
  readonly reading: CoverageReading;
  readonly required: CoveragePin | undefined;
  readonly findings: readonly Finding[];
}

const isOwnSource = (unit: CoverageUnit, file: string): boolean =>
  // `startsWith`, NOT `includes`. Bun writes `SF:` paths relative to the repo root, and both
  // tracked apps carry a package of their own under the same name —
  // `examples/dummy/packages/mcp/src/` and `dummy/social-media-clone/packages/mcp/src/` each
  // CONTAIN `packages/mcp/src/`. A substring test folded them into the framework package's
  // reading: `@ultimat3/mcp` measured 96.99% while its own sources were at 100%, carrying 35
  // uncovered lines that belong to an app gated on its own ratchet.
  file.startsWith(unit.source) &&
  !TEST_FILE.test(file) &&
  !COVERAGE_EXCLUDED.some((fragment) => file.includes(fragment));

/**
 * Sum an lcov report over one unit's own sources.
 *
 * A record is counted when its `SF:` names a file under the unit's source that is neither a test
 * nor excluded. Everything else in the file belongs to a package this run merely imported, and
 * folding it in is the dilution this gate exists to undo.
 */
export function scopeLcov(lcov: string, name: string): CoverageReading {
  const unit = unitOf(name);
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  for (const record of parseLcov(lcov)) {
    if (!isOwnSource(unit, record.file)) continue;
    lf += record.linesFound;
    lh += record.linesHit;
    fnf += record.funcsFound;
    fnh += record.funcsHit;
  }
  return {
    pkg: name,
    lines: percent(lh, lf),
    funcs: percent(fnh, fnf),
    measured: lf,
    unimported: [],
  };
}

/**
 * An `SF:` path as a path relative to `root`, which is the only form a glob result can be compared
 * against. Bun writes them root-relative; an absolute one and a `./`-prefixed one are normalised
 * rather than matched by suffix.
 *
 * `endsWith('/' + rel)` was the compare, and it re-introduced the exact collision `isOwnSource` has
 * a paragraph about above: both tracked apps carry `packages/<name>/src/`, so the app's
 * `examples/dummy/packages/mcp/src/mcp.ts` ENDS WITH `/packages/mcp/src/mcp.ts` and answered for
 * the framework file of that name. A framework module no suite imports then read as recorded, and
 * `X_COVERAGE_UNMEASURED` — the check whose whole job is to notice a file no test ever loads — went
 * quiet for every name an app happens to share.
 */
const rootRelative = (root: string, file: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  return file.startsWith('./') ? file.slice(2) : file;
};

/** Every non-test source file of the unit that has executable code and no lcov record. */
export function unimportedSources(root: string, name: string, lcov: string): readonly string[] {
  const unit = unitOf(name);
  const recorded = new Set(parseLcov(lcov).map((record) => rootRelative(root, record.file)));
  const missing: string[] = [];
  for (const rel of new Bun.Glob(unit.glob).scanSync({ cwd: root })) {
    if (TEST_FILE.test(rel)) continue;
    if (/\.d\.ts$/.test(rel)) continue;
    if (COVERAGE_EXCLUDED.some((fragment) => rel.includes(fragment))) continue;
    if (recorded.has(rel)) continue;
    if (!hasExecutableCode(readFileSync(join(root, rel), 'utf8'))) continue;
    missing.push(rel);
  }
  return missing.sort();
}

/**
 * Both directions, because a ratchet that only tightens on regression is a ceiling.
 *
 * `X_COVERAGE_UNMEASURED` is first and is not a formality: an lcov with no record for this
 * unit — a suite that did not run, a directory renamed, a `--coverage` flag dropped — sums to
 * 0/0, and a naive percentage over that reads as a pass over nothing.
 */
export function judge(reading: CoverageReading, pin: CoveragePin | undefined): CoverageVerdict {
  const findings: Finding[] = [];
  const unit = unitOf(reading.pkg);
  const at = atOf(unit);
  if (reading.measured === 0) {
    findings.push({
      code: 'X_COVERAGE_UNMEASURED',
      at,
      cause: `no lcov record names a file under ${unit.source}, so its coverage is a percentage of nothing`,
      fix: `run bun test --coverage ${unit.test} and confirm the suite runs; a unit whose tests do not run cannot pass this gate`,
    });
    return { reading, required: pin, findings };
  }

  if (reading.unimported.length > 0) {
    findings.push({
      code: 'X_COVERAGE_UNMEASURED',
      at,
      cause: `${reading.unimported.length} file(s) under ${unit.source} have executable code and NO lcov record, so they are absent from the percentage rather than counted as zero: ${reading.unimported.slice(0, 5).join(', ')}${reading.unimported.length > 5 ? ', …' : ''}`,
      fix: `import each of them from a test beside it — a file nothing reaches makes this unit's coverage read HIGHER, which is the one direction an unmeasured file must never move it`,
    });
  }

  // Screened, not trusted. A pin is hand-written, so `lines: NaN` is a typo away — and
  // `reading.lines < NaN` is FALSE for every reading, so the floor stops enforcing rather than
  // enforcing the wrong number. That is this repo's most repeated defect and the direction that
  // hides: a coverage gate that passes everything, reporting green. `finiteOption` is the tier-0
  // check every package uses; `scripts/` reaches it the same way `boundaries.ts` reaches core.
  const floorLines = finiteOption('the coverage pin', 'lines', pin?.lines ?? COVERAGE_TARGET);
  const floorFuncs = finiteOption('the coverage pin', 'funcs', pin?.funcs ?? COVERAGE_TARGET);
  if (reading.lines < floorLines || reading.funcs < floorFuncs) {
    findings.push({
      code: 'X_COVERAGE_BELOW',
      at,
      cause:
        `${unit.source} is at ${reading.lines}% lines / ${reading.funcs}% functions, ` +
        `under the ${pin === undefined ? `${COVERAGE_TARGET}% target` : `pin of ${floorLines}% / ${floorFuncs}%`}`,
      fix:
        pin === undefined
          ? `cover the gap with tests beside the source, then re-run bun run scripts/coverage-gate.ts --package ${reading.pkg}`
          : `restore the coverage this commit removed — a pinned unit may not fall further; the pin in ${PINS_FILE} records what it was`,
    });
  }

  if (pin !== undefined && reading.lines >= COVERAGE_TARGET && reading.funcs >= COVERAGE_TARGET) {
    findings.push({
      code: 'X_COVERAGE_PIN_STALE',
      at,
      cause: `${at} now clears the ${COVERAGE_TARGET}% target at ${reading.lines}% / ${reading.funcs}%, and ${PINS_FILE} still pins it lower`,
      fix: `delete the "${reading.pkg}" entry from COVERAGE_PINS in ${PINS_FILE}`,
    });
  } else if (
    pin !== undefined &&
    reading.lines >= pin.lines + PIN_SLACK &&
    reading.funcs >= pin.funcs + PIN_SLACK
  ) {
    findings.push({
      code: 'X_COVERAGE_PIN_STALE',
      at,
      cause: `${at} is at ${reading.lines}% / ${reading.funcs}%, more than ${PIN_SLACK} points above its pin of ${pin.lines}% / ${pin.funcs}%`,
      fix: `raise the "${reading.pkg}" pin in ${PINS_FILE} to the measured numbers, so the next regression is caught against today rather than against last quarter`,
    });
  }

  return { reading, required: pin, findings };
}

/**
 * The verdict on a suite's exit code, which is the half of a coverage run that is not coverage and
 * was never read: a package whose suite FAILED alone still wrote an lcov report, cleared its bar,
 * and passed — so the isolation this gate runs per unit to prove was proved by nothing.
 * Measured: a probe asserting `1 === 2` in `packages/money` left `--package money` green.
 */
/** How much of a failed run's end the cause carries when no line names the failure. */
const UNNAMED_TAIL_LINES = 20;

export function suiteFailure(
  name: string,
  exitCode: number,
  stderr: string,
): { code: string; cause: string; fix: string } | undefined {
  if (exitCode === 0) return undefined;
  const unit = unitOf(name);
  const lines = stderr.split('\n').map((line) => line.trim());
  const failed = lines
    .filter((line) => /^\(fail\)|^error:|^::error\b|\btimed out\b/.test(line))
    .slice(0, 12);
  // The assertion's own diff — what the test RECEIVED — is the half that names the cause; a CI
  // flake reported as `error: expect(received).toEqual(expected)` alone cannot be root-caused.
  const diff = lines.filter((line) => /^(?:[-+]\s|Expected:|Received:)/.test(line)).slice(0, 24);
  // Nothing named: an unhandled error between tests, a crash, a non-zero exit with every test
  // green. The run's own last lines are then the only evidence, and CI keeps no other copy.
  const tail =
    failed.length === 0 && diff.length === 0
      ? lines.filter((line) => line !== '').slice(-UNNAMED_TAIL_LINES)
      : [];
  return {
    code: 'X_TEST_FAILED',
    cause: `bun test ${unit.test} failed when run alone${failed.length > 0 ? `: ${failed.join('; ')}` : ''}${diff.length > 0 ? ` — the assertion's diff: ${diff.join(' | ')}` : ''}${tail.length > 0 ? ` — exit ${String(exitCode)}, and the run ended: ${tail.join(' | ')}` : ''}`,
    fix: `run bun test ${unit.test} and fix what it reports — a suite green only beside other packages depends on something another package registered first`,
  };
}

/**
 * `scripts/` counts a file no test loads at 0% — weighed off its source, the rule an app's
 * `x verify` applies to its own tree (`coverage-floor.ts`) — where a package REFUSES one. A
 * package's modules are library code a test can always import; half of `scripts/` is entry
 * points whose body is the `import.meta.main` block, and refusing each would be a pin list of
 * its own. Counted, they drag the one number down and the one pin says so.
 */
export function withUnloadedCounted(
  root: string,
  reading: CoverageReading,
  lcov: string,
): CoverageReading {
  const unit = unitOf(reading.pkg);
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  for (const record of parseLcov(lcov)) {
    if (!isOwnSource(unit, record.file)) continue;
    lf += record.linesFound;
    lh += record.linesHit;
    fnf += record.funcsFound;
    fnh += record.funcsHit;
  }
  for (const rel of reading.unimported) {
    const weight = unloadedWeight(readFileSync(join(root, rel), 'utf8'));
    lf += weight.lines;
    fnf += weight.funcs;
  }
  return {
    ...reading,
    lines: percent(lh, lf),
    funcs: percent(fnh, fnf),
    measured: lf,
    unimported: [],
  };
}

/**
 * The `bun test` one unit is measured by. One worker is the command this gate always ran: ONE
 * process, every file sharing it. More is `--parallel=<n>`, which implies `--isolate`: n processes,
 * every FILE in a fresh global, the way `x verify`'s `unit` step already runs every one of them —
 * and Bun folds the coverage of every file and worker into one lcov by FUNCTION IDENTITY, which
 * this gate cannot do itself (its lcov carries counts, no `FN:` lines).
 * `coverage-gate-parallel.test.ts` holds that premise against the real `bun`.
 *
 * Measured 2026-11-05, Bun 1.4.4, one process against isolated workers on the same tree, same
 * denominators: `cli` 96.54% / 95.51% one process, 96.51% / 95.50% on four; `scripts`, `core`,
 * `db`, `testing`, `admin`, `http`, `ai`, `action`, `auth`, `scraping`, `entity`, `jobs`
 * identical to the hundredth. Lower, and the same at 1, 2 and 4 workers: `render` functions
 * 97.12% → 96.87% (`registry.ts`), `ui` 97.45% → 97.34% — functions reached only through state
 * an EARLIER file left in the one process, which no test of their own calls. A number that
 * depends on which file ran first is not one this gate should report. (`render` and `ui` stay one
 * process under `FILES_PER_WORKER` today; the number is what they would read widened.)
 *
 * Isolated and not `--no-isolate`, which costs a third less CPU: with files sharing a worker's
 * registry, WHICH files share one is decided by the clock, and two suites green in one process
 * went red that way, every run (`entity`'s `test-driver.test.ts`, `cli`'s
 * `unscanned-admin.test.ts`) — a failure a rerun can move is a flake this gate would mint.
 * `--isolate` alone was refused on 2026-09-05 because Bun's lcov then kept the last file's record,
 * not the union (`packages/admin` 92.04% against 99.73%); Bun 1.4.4 unions them, and the premise
 * test above fails if a Bun stops.
 *
 * Every e2e path is left out (`E2E_PATH_GLOBS`, the one definition the e2e step selects by). An
 * e2e suite drives a built app through a browser and child processes, which no in-process lcov
 * sees, and it already runs in its own gate step: here it was `cli`'s long pole twice over.
 * Measured 2026-11-09, one tree, four workers: `cli` 285 s → 195 s, 96.15/95.46 → 96.14/95.42;
 * the five other units carrying e2e suites unmoved against their bars. Contract, live and job
 * suites stay in: `jobs` is measured by its job suites, and without them read 92.13/91.22.
 */
export function testCommand(unit: CoverageUnit, dir: string, workers: number): readonly string[] {
  const wide = workers > 1 ? [`--parallel=${String(workers)}`] : [];
  return [
    'bun',
    'test',
    '--coverage',
    '--coverage-reporter=lcov',
    `--coverage-dir=${dir}`,
    ...wide,
    ...E2E_PATH_GLOBS.map((glob) => `--path-ignore-patterns=${glob}`),
    unit.test,
  ];
}

/** Runs one unit's suite with coverage, on `workers` workers, and reads the report back. */
async function measure(root: string, name: string, workers: number): Promise<CoverageReading> {
  const unit = unitOf(name);
  const dir = join(root, '.x', 'coverage', name);
  rmSync(dir, { recursive: true, force: true });
  const started = performance.now();
  const proc = Bun.spawn([...testCommand(unit, dir, workers)], {
    cwd: root,
    env: unitEnv(Bun.env, serviceKeys(root)),
    // Both read: under GitHub Actions Bun reports a failing test as an `::error` annotation on
    // stdout, so stderr alone named three failures as "3 tests failed:" and nothing else.
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const failure = suiteFailure(name, await proc.exited, `${stdout}\n${stderr}`);
  if (failure !== undefined) throw new ScriptError(failure);
  const file = Bun.file(join(dir, 'lcov.info'));
  if (!(await file.exists())) {
    throw new ScriptError({
      code: 'X_COVERAGE_UNMEASURED',
      cause: `bun test wrote no lcov report for ${unit.test}: ${stderr.trim().split('\n').at(-1) ?? 'no output'}`,
      fix: `run bun test ${unit.test} and fix the failure it reports; coverage cannot be read from a suite that did not finish`,
    });
  }
  const lcov = await file.text();
  const scoped = { ...scopeLcov(lcov, name), unimported: unimportedSources(root, name, lcov) };
  const reading = unit === SCRIPTS_UNIT ? withUnloadedCounted(root, scoped, lcov) : scoped;
  rmSync(dir, { recursive: true, force: true });
  return { ...reading, seconds: Math.round((performance.now() - started) / 100) / 10, workers };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const json = flagBool(args, 'json');
  const root = repoRoot();
  let names: readonly string[];
  try {
    names = unitsFor(root, args.flags);
  } catch (error) {
    if (!(error instanceof BadFlagError)) throw error;
    report(
      {
        ok: false,
        script: 'coverage-gate',
        summary: 'refused',
        findings: [{ code: error.code, cause: error.cause, fix: error.fix }],
      },
      json,
    );
  }
  const jobs = concurrency(flagString(args, 'jobs'));
  if (jobs === undefined) {
    report(
      {
        ok: false,
        script: 'coverage-gate',
        summary: '--jobs takes a positive integer — the number of unit suites run at once',
        findings: [],
      },
      json,
    );
  }
  // A unit leases as many cores as it runs workers, so a widened `cli` and three narrow units
  // never ask a 4-core runner for seven at once.
  const width = new Map(
    names.map((name) => [name, workersFor(testFileCount(root, unitOf(name)), jobs)]),
  );
  const settled = await leasePool(
    names,
    jobs,
    (name) => width.get(name) ?? 1,
    async (name): Promise<CoverageVerdict | Finding> => {
      try {
        return judge(await measure(root, name, width.get(name) ?? 1), COVERAGE_PINS[name]);
      } catch (error) {
        if (!(error instanceof ScriptError)) throw error;
        return { ...error.toFinding(), at: atOf(unitOf(name)) };
      }
    },
  );
  // Reported in unit order whatever order the pool finished in, so two runs of one tree print
  // one report.
  const verdicts: CoverageVerdict[] = [];
  const findings: Finding[] = [];
  for (const outcome of settled) {
    if ('reading' in outcome) {
      verdicts.push(outcome);
      findings.push(...outcome.findings);
    } else findings.push(outcome);
  }

  const ok = findings.length === 0;
  const shard = flagString(args, 'shard');
  report(
    {
      ok,
      script: 'coverage-gate',
      summary: ok
        ? `${verdicts.length} unit(s)${shard === undefined ? '' : ` of shard ${shard}`} at or above their bar — target ${COVERAGE_TARGET}%, ${Object.keys(COVERAGE_PINS).length} pinned`
        : `${findings.length} coverage finding(s) across ${names.length} unit(s)`,
      findings,
      // Slowest first: the line to read when a shard is the slow one and the split needs moving.
      lines: [...verdicts]
        .sort((a, b) => (b.reading.seconds ?? 0) - (a.reading.seconds ?? 0))
        .map(
          (verdict) =>
            `  ${String(verdict.reading.seconds ?? 0).padStart(6)}s  ${verdict.reading.pkg}  ${verdict.reading.lines}% / ${verdict.reading.funcs}%${(verdict.reading.workers ?? 1) > 1 ? `  (${String(verdict.reading.workers)} workers)` : ''}`,
        ),
      data: verdicts.map((verdict) => verdict.reading),
    },
    json,
  );
}
