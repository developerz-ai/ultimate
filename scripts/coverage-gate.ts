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
//   bun run scripts/coverage-gate.ts --all [--jobs <n>] [--shard i/n] [--unit-timeout <seconds>] [--json]
//   bun run scripts/coverage-gate.ts --merge <dir> [--json]
//
// `--shard i/n` is one CI runner's share of `--all`, dealt by each unit's measured core-seconds
// (`UNIT_SECONDS`), so shard 1/2 is the same units on every runner. A unit too heavy for one runner
// is measured as parts (`lib/coverage-parts.ts`): a shard holding a part leaves its coverage in
// `.x/coverage-parts/`, and `--merge` folds every part into the one reading the bar judges. The lcov
// reader is the CLI's (`coverage-lcov.ts`), the one an app's `x verify` reads its own floor through.

// why: mkdirSync/rmSync — Bun has no recursive directory creation or removal; `join`/`resolve` —
// Bun ships no path joiner.
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finiteOption, renderFixShellArg } from '@ultimat3/core';
import { BadFlagError } from '../packages/cli/src/errors';
import { withHeavy } from '../packages/cli/src/heavy';
import { TEST_RUN_BASE_MB, TEST_WORKER_PEAK_MB } from '../packages/cli/src/heavy-weights';
import { quoteArg } from '../packages/cli/src/shell-quote';
import { E2E_PATH_GLOBS } from '../packages/cli/src/verify-tests';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { PartDocument, UnitPart } from './lib/coverage-parts';
import {
  foldParts,
  ownCoverage,
  PARTS_DIR,
  partDocument,
  partFile,
  partName,
  readParts,
  unitOfName,
} from './lib/coverage-parts';
import type { CoveragePin } from './lib/coverage-pins';
import { COVERAGE_PINS, COVERAGE_TARGET, PIN_SLACK, PINS_FILE } from './lib/coverage-pins';
import type { CoverageReading } from './lib/coverage-reading';
import { ownSourceOf, readingOf } from './lib/coverage-reading';
import {
  concurrency,
  leasePool,
  serviceKeys,
  timedOutFinding,
  UNIT_TIMEOUT_MS,
  unitEnv,
  unitTimeoutOf,
  workersFor,
} from './lib/coverage-schedule';
import type { CoverageUnit } from './lib/coverage-units';
import { atOf, testFilesOf, unitOf, unitPlan, unitsFor } from './lib/coverage-units';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { RunResult } from './lib/run';
import { repoRoot, run } from './lib/run';
import { ScriptError } from './lib/script-error';
import { stopTreeOnSignal } from './lib/stop-tree';
import { README_FACTS_FIX, README_FILE } from './readme-facts';

/**
 * One unit's verdict. `required` is what it had to clear — the target, or its pin.
 */
export interface CoverageVerdict {
  readonly reading: CoverageReading;
  readonly required: CoveragePin | undefined;
  readonly findings: readonly Finding[];
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
      fix: `bun test --coverage ${quoteArg(unit.test)}   # confirm the suite runs; a unit whose tests do not run cannot pass this gate`,
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
          ? `bun test --coverage ${quoteArg(unit.test)}   # prints the uncovered lines: cover them with tests beside the source, then: bun run scripts/coverage-gate.ts --package ${quoteArg(reading.pkg)}`
          : `bun test --coverage ${quoteArg(unit.test)}   # prints the uncovered lines: restore the coverage this commit removed — a pinned unit may not fall further, and the pin in ${PINS_FILE} records what it was — then: bun run scripts/coverage-gate.ts --package ${quoteArg(reading.pkg)}`,
    });
  }

  if (pin !== undefined && reading.lines >= COVERAGE_TARGET && reading.funcs >= COVERAGE_TARGET) {
    findings.push({
      code: 'X_COVERAGE_PIN_STALE',
      at,
      cause: `${at} now clears the ${COVERAGE_TARGET}% target at ${reading.lines}% / ${reading.funcs}%, and ${PINS_FILE} still pins it lower`,
      fix: `grep -nE "^  '?${renderFixShellArg(reading.pkg, '<pkg>')}'?:" ${PINS_FILE}   # delete that entry from COVERAGE_PINS, then: ${README_FACTS_FIX} — ${README_FILE}'s facts table quotes every pin (X_README_FACTS_DRIFT)`,
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
      fix: `grep -nE "^  '?${renderFixShellArg(reading.pkg, '<pkg>')}'?:" ${PINS_FILE}   # raise that entry of COVERAGE_PINS to lines: ${String(Math.floor(reading.lines))}, funcs: ${String(Math.floor(reading.funcs))}, so the next regression is caught against today rather than against last quarter; then: ${README_FACTS_FIX} — ${README_FILE}'s facts table quotes every pin (X_README_FACTS_DRIFT)`,
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
    fix: `bun test ${quoteArg(unit.test)}   # fix what it reports — a suite green only beside other packages depends on something another package registered first`,
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
export function testCommand(
  unit: CoverageUnit,
  dir: string,
  workers: number,
  files?: readonly string[],
): readonly string[] {
  const wide = workers > 1 ? [`--parallel=${String(workers)}`] : [];
  return [
    'bun',
    'test',
    '--coverage',
    '--coverage-reporter=lcov',
    `--coverage-dir=${dir}`,
    ...wide,
    ...E2E_PATH_GLOBS.map((glob) => `--path-ignore-patterns=${glob}`),
    // A part names its files, each `./`-prefixed: a bare path is a substring filter to `bun test`.
    ...(files === undefined ? [unit.test] : files.map((file) => `./${file}`)),
  ];
}

/** A finished run's verdict: the deadline's own coded line, a failing suite, or `undefined`. */
export function unitFailure(
  name: string,
  ran: Pick<RunResult, 'code' | 'output' | 'timedOut'>,
  timeoutMs: number = UNIT_TIMEOUT_MS,
  files: readonly string[] = [],
): { code: string; cause: string; fix: string } | undefined {
  if (ran.timedOut) return timedOutFinding(name, unitOf(name).test, ran.output, timeoutMs, files);
  return suiteFailure(name, ran.code ?? 1, ran.output);
}

/** One scheduled name: a whole unit, or one part of a unit's plan. */
interface Scheduled {
  readonly name: string;
  readonly unit: string;
  readonly part?: UnitPart;
}

/** A measured name: a whole unit's verdict, a part's document, or the finding that stopped it. */
type Measured =
  | { readonly kind: 'verdict'; readonly verdict: CoverageVerdict }
  | { readonly kind: 'part'; readonly doc: PartDocument }
  | { readonly kind: 'finding'; readonly finding: Finding };

/** Runs one suite with coverage — a whole unit, or a part's files — and answers its lcov. */
async function measure(
  root: string,
  item: Scheduled,
  workers: number,
  timeoutMs: number,
): Promise<{ readonly lcov: string; readonly seconds: number }> {
  const unit = unitOf(item.unit);
  const dir = join(root, '.x', 'coverage', item.name.replace(/[#/]/g, '-'));
  rmSync(dir, { recursive: true, force: true });
  const started = performance.now();
  // Both pipes are read: under GitHub Actions Bun reports a failing test as an `::error`
  // annotation on stdout, so stderr alone named three failures as "3 tests failed:" and nothing
  // else. `run()` owns the deadline: a suite that hangs is killed and reported, never waited on.
  // One reservation per unit suite, its whole width, and the deadline starts once it is admitted.
  const ran = await withHeavy(
    {
      label: `coverage ${item.name}`,
      cwd: root,
      env: Bun.env,
      unitMb: TEST_WORKER_PEAK_MB,
      baseMb: TEST_RUN_BASE_MB,
      units: workers,
    },
    (child) =>
      run(testCommand(unit, dir, workers, item.part?.files), {
        cwd: root,
        env: { ...unitEnv(Bun.env, serviceKeys(root)), ...child.env },
        inheritFds: child.fds,
        timeoutMs,
      }),
  );
  const files = item.part?.files ?? testFilesOf(root, unit);
  const failure = unitFailure(item.unit, ran, timeoutMs, files);
  if (failure !== undefined) throw new ScriptError(failure);
  const file = Bun.file(join(dir, 'lcov.info'));
  if (!(await file.exists())) {
    throw new ScriptError({
      code: 'X_COVERAGE_UNMEASURED',
      cause: `bun test wrote no lcov report for ${unit.test}: ${ran.output.trim().split('\n').at(-1) ?? 'no output'}`,
      fix: `bun test ${quoteArg(unit.test)}   # fix the failure it reports; coverage cannot be read from a suite that did not finish`,
    });
  }
  const lcov = await file.text();
  rmSync(dir, { recursive: true, force: true });
  return { lcov, seconds: Math.round((performance.now() - started) / 100) / 10 };
}

/** A whole unit's verdict, from its own lcov or its parts' fold. */
function verdictOf(
  root: string,
  name: string,
  lcov: string,
  run: { readonly seconds: number; readonly workers: number },
): CoverageVerdict {
  return judge({ ...readingOf(root, name, lcov), ...run }, COVERAGE_PINS[name]);
}

/** Folds each cut unit from `docs`; units whose parts are not all here are left to `--merge`. */
function foldAll(
  root: string,
  units: readonly string[],
  docs: readonly PartDocument[],
): readonly (CoverageVerdict | Finding)[] {
  return units.map((name) => {
    const folded = foldParts(unitPlan(root, name), docs);
    if ('code' in folded) return { ...folded, at: atOf(unitOf(name)) };
    return verdictOf(root, name, folded.lcov, {
      seconds: folded.seconds,
      workers: folded.workers,
    });
  });
}

if (import.meta.main) {
  // Stopped, it stops the suites it started: an orphan kept the ledger reservation it inherited.
  stopTreeOnSignal('coverage-gate');
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
  const unitTimeout = unitTimeoutOf(flagString(args, 'unit-timeout'));
  const jobs = concurrency(flagString(args, 'jobs'));
  if (jobs === undefined || unitTimeout === undefined) {
    report(
      {
        ok: false,
        script: 'coverage-gate',
        summary:
          jobs === undefined
            ? '--jobs takes a positive integer — the number of unit suites run at once'
            : "--unit-timeout takes whole seconds — one unit's deadline, below the CI job's own",
        findings: [],
      },
      json,
    );
  }
  const merge = flagString(args, 'merge');
  const outcomes: (CoverageVerdict | Finding)[] = [];
  const parts: PartDocument[] = [];
  if (merge !== undefined) {
    outcomes.push(...foldAll(root, names, await readParts(resolve(root, merge))));
  } else {
    // Each name resolved once: a part carries its files, dealt by the plan every runner computes.
    const plans = new Map<string, readonly UnitPart[]>();
    const items: Scheduled[] = names.map((name) => {
      const unit = unitOfName(name);
      if (unit === name) return { name, unit };
      const plan = plans.get(unit) ?? unitPlan(root, unit);
      plans.set(unit, plan);
      return { name, unit, part: plan.find((one) => partName(one) === name) as UnitPart };
    });
    // A unit leases as many cores as it runs workers, so a widened `cli` and three narrow units
    // never ask a 4-core runner for seven at once.
    const width = new Map(
      items.map((item) => [
        item.name,
        workersFor((item.part?.files ?? testFilesOf(root, unitOf(item.unit))).length, jobs),
      ]),
    );
    const settled = await leasePool(
      items,
      jobs,
      (item) => width.get(item.name) ?? 1,
      async (item): Promise<Measured> => {
        try {
          const workers = width.get(item.name) ?? 1;
          const ran = await measure(root, item, workers, unitTimeout ?? UNIT_TIMEOUT_MS);
          if (item.part === undefined) {
            return {
              kind: 'verdict',
              verdict: verdictOf(root, item.unit, ran.lcov, { seconds: ran.seconds, workers }),
            };
          }
          const own = ownCoverage(ran.lcov, ownSourceOf(item.unit));
          return {
            kind: 'part',
            doc: partDocument(item.part, own, { seconds: ran.seconds, workers }),
          };
        } catch (error) {
          if (!(error instanceof ScriptError)) throw error;
          return {
            kind: 'finding',
            finding: { ...error.toFinding(), at: atOf(unitOf(item.unit)) },
          };
        }
      },
    );
    for (const outcome of settled) {
      if (outcome.kind === 'verdict') outcomes.push(outcome.verdict);
      else if (outcome.kind === 'finding') outcomes.push(outcome.finding);
      else parts.push(outcome.doc);
    }
    // A unit whose every part ran here is judged here; one cut across shards waits for `--merge`.
    const cut = [...plans].filter(([, plan]) =>
      plan.every((part) => parts.some((doc) => doc.unit === part.unit && doc.index === part.index)),
    );
    outcomes.push(
      ...foldAll(
        root,
        cut.map(([unit]) => unit),
        parts,
      ),
    );
    const left = parts.filter((doc) => !cut.some(([unit]) => unit === doc.unit));
    if (left.length > 0) mkdirSync(join(root, PARTS_DIR), { recursive: true });
    for (const doc of left)
      await Bun.write(join(root, PARTS_DIR, partFile(doc)), JSON.stringify(doc));
  }
  const verdicts: CoverageVerdict[] = [];
  const findings: Finding[] = [];
  for (const outcome of outcomes) {
    if ('reading' in outcome) {
      verdicts.push(outcome);
      findings.push(...outcome.findings);
    } else findings.push(outcome);
  }
  // Reported in unit order whatever order the pool finished in, so two runs of one tree print
  // one report.
  verdicts.sort((a, b) =>
    a.reading.pkg < b.reading.pkg ? -1 : a.reading.pkg > b.reading.pkg ? 1 : 0,
  );

  const ok = findings.length === 0;
  const shard = flagString(args, 'shard');
  const scope =
    merge !== undefined
      ? ' folded from their parts'
      : shard === undefined
        ? ''
        : ` of shard ${shard}`;
  report(
    {
      ok,
      script: 'coverage-gate',
      summary: ok
        ? `${verdicts.length} unit(s)${scope} at or above their bar — target ${COVERAGE_TARGET}%, ${Object.keys(COVERAGE_PINS).length} pinned`
        : `${findings.length} coverage finding(s) across ${names.length} unit(s)`,
      findings,
      // Slowest first: the line to read when a shard is the slow one and the split needs moving.
      // A part measured here and judged by `--merge` is listed with its time and no verdict.
      lines: [
        ...[...verdicts]
          .sort((a, b) => (b.reading.seconds ?? 0) - (a.reading.seconds ?? 0))
          .map(
            (verdict) =>
              `  ${String(verdict.reading.seconds ?? 0).padStart(6)}s  ${verdict.reading.pkg}  ${verdict.reading.lines}% / ${verdict.reading.funcs}%${(verdict.reading.workers ?? 1) > 1 ? `  (${String(verdict.reading.workers)} workers)` : ''}`,
          ),
        ...parts
          .filter((doc) => !verdicts.some((verdict) => verdict.reading.pkg === doc.unit))
          .map(
            (doc) =>
              `  ${String(doc.seconds).padStart(6)}s  ${partName(doc)}  (${String(doc.workers)} workers) — judged by --merge, written to ${PARTS_DIR}/${partFile(doc)}`,
          ),
      ],
      data: verdicts.map((verdict) => verdict.reading),
    },
    json,
  );
}
