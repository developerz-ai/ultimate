#!/usr/bin/env bun
// Enforce, per package, that a package's own `src/` is covered by its own tests.
//
// Scoped deliberately. `bun test packages/<pkg>` loads every package that one imports, and Bun's
// summary row averages over ALL of them — so `@ultimat3/cache` read 35% while its own sources were
// at 98.8%, the difference being tier-0 and tier-1 files its tests never exercise. A number that
// wrong in that direction is worse than none: it reads as a crisis nobody can act on, and it moves
// when an unrelated package grows.
//
//   bun run scripts/coverage-gate.ts --package core [--json]
//   bun run scripts/coverage-gate.ts --all [--json]

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { CoveragePin } from './lib/coverage-pins';
import {
  COVERAGE_EXCLUDED,
  COVERAGE_PINS,
  COVERAGE_TARGET,
  PIN_SLACK,
  PINS_FILE,
} from './lib/coverage-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

export interface CoverageReading {
  readonly pkg: string;
  readonly lines: number;
  readonly funcs: number;
  /** Lines found in the package's own `src/`. Zero is the false green this gate refuses. */
  readonly measured: number;
}

/**
 * One package's verdict. `required` is what it had to clear — the target, or its pin.
 */
export interface CoverageVerdict {
  readonly reading: CoverageReading;
  readonly required: CoveragePin | undefined;
  readonly findings: readonly Finding[];
}

const pct = (hit: number, found: number): number =>
  found === 0 ? 0 : Math.round((hit / found) * 10_000) / 100;

/**
 * Sum an lcov report over one package's own sources.
 *
 * A record is counted when its `SF:` names a file under `packages/<pkg>/src/` that is neither a
 * test nor excluded. Everything else in the file belongs to a package this run merely imported,
 * and folding it in is the dilution this gate exists to undo.
 */
export function scopeLcov(lcov: string, pkg: string): CoverageReading {
  const prefix = `packages/${pkg}/src/`;
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  let counting = false;
  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      const file = line.slice(3);
      counting =
        file.includes(prefix) &&
        !/\.test\.[cm]?[jt]sx?$/.test(file) &&
        !COVERAGE_EXCLUDED.some((fragment) => file.includes(fragment));
      continue;
    }
    if (!counting) continue;
    if (line.startsWith('LF:')) lf += Number(line.slice(3));
    else if (line.startsWith('LH:')) lh += Number(line.slice(3));
    else if (line.startsWith('FNF:')) fnf += Number(line.slice(4));
    else if (line.startsWith('FNH:')) fnh += Number(line.slice(4));
  }
  return { pkg, lines: pct(lh, lf), funcs: pct(fnh, fnf), measured: lf };
}

/**
 * Both directions, because a ratchet that only tightens on regression is a ceiling.
 *
 * `X_COVERAGE_UNMEASURED` is first and is not a formality: an lcov with no record for this
 * package — a suite that did not run, a directory renamed, a `--coverage` flag dropped — sums to
 * 0/0, and a naive percentage over that reads as a pass over nothing.
 */
export function judge(reading: CoverageReading, pin: CoveragePin | undefined): CoverageVerdict {
  const findings: Finding[] = [];
  const at = `packages/${reading.pkg}`;
  if (reading.measured === 0) {
    findings.push({
      code: 'X_COVERAGE_UNMEASURED',
      at,
      cause: `no lcov record names a file under packages/${reading.pkg}/src/, so its coverage is a percentage of nothing`,
      fix: `run bun test --coverage packages/${reading.pkg} and confirm the suite runs; a package whose tests do not run cannot pass this gate`,
    });
    return { reading, required: pin, findings };
  }

  const floorLines = pin?.lines ?? COVERAGE_TARGET;
  const floorFuncs = pin?.funcs ?? COVERAGE_TARGET;
  if (reading.lines < floorLines || reading.funcs < floorFuncs) {
    findings.push({
      code: 'X_COVERAGE_BELOW',
      at,
      cause:
        `packages/${reading.pkg}/src/ is at ${reading.lines}% lines / ${reading.funcs}% functions, ` +
        `under the ${pin === undefined ? `${COVERAGE_TARGET}% target` : `pin of ${floorLines}% / ${floorFuncs}%`}`,
      fix:
        pin === undefined
          ? `cover the gap with tests beside the source, then re-run bun run scripts/coverage-gate.ts --package ${reading.pkg}`
          : `restore the coverage this commit removed — a pinned package may not fall further; the pin in ${PINS_FILE} records what it was`,
    });
  }

  if (pin !== undefined && reading.lines >= COVERAGE_TARGET && reading.funcs >= COVERAGE_TARGET) {
    findings.push({
      code: 'X_COVERAGE_PIN_STALE',
      at,
      cause: `packages/${reading.pkg} now clears the ${COVERAGE_TARGET}% target at ${reading.lines}% / ${reading.funcs}%, and ${PINS_FILE} still pins it lower`,
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
      cause: `packages/${reading.pkg} is at ${reading.lines}% / ${reading.funcs}%, more than ${PIN_SLACK} points above its pin of ${pin.lines}% / ${pin.funcs}%`,
      fix: `raise the "${reading.pkg}" pin in ${PINS_FILE} to the measured numbers, so the next regression is caught against today rather than against last quarter`,
    });
  }

  return { reading, required: pin, findings };
}

/** Runs one package's suite with coverage and reads the report back. */
async function measure(root: string, pkg: string): Promise<CoverageReading> {
  const dir = join(root, '.x', 'coverage', pkg);
  rmSync(dir, { recursive: true, force: true });
  const proc = Bun.spawn(
    [
      'bun',
      'test',
      '--coverage',
      '--coverage-reporter=lcov',
      `--coverage-dir=${dir}`,
      `packages/${pkg}`,
    ],
    { cwd: root, stdout: 'ignore', stderr: 'pipe' },
  );
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const file = Bun.file(join(dir, 'lcov.info'));
  if (!(await file.exists())) {
    throw new ScriptError({
      code: 'X_COVERAGE_UNMEASURED',
      cause: `bun test wrote no lcov report for packages/${pkg}: ${stderr.trim().split('\n').at(-1) ?? 'no output'}`,
      fix: `run bun test packages/${pkg} and fix the failure it reports; coverage cannot be read from a suite that did not finish`,
    });
  }
  const reading = scopeLcov(await file.text(), pkg);
  rmSync(dir, { recursive: true, force: true });
  return reading;
}

async function packagesToGate(root: string, only: string | undefined): Promise<readonly string[]> {
  if (only !== undefined) return [only];
  const entries = [...new Bun.Glob('packages/*/src').scanSync({ cwd: root, onlyFiles: false })];
  return entries.map((path) => path.split('/')[1] as string).sort();
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const json = flagBool(args, 'json');
  const root = repoRoot();
  const only = flagString(args, 'package');
  if (only === undefined && !flagBool(args, 'all')) {
    report(
      {
        ok: false,
        script: 'coverage-gate',
        summary: 'name a package with --package <name>, or pass --all',
        findings: [],
      },
      json,
    );
  }

  const names = await packagesToGate(root, only);
  const verdicts: CoverageVerdict[] = [];
  const findings: Finding[] = [];
  for (const pkg of names) {
    try {
      const verdict = judge(await measure(root, pkg), COVERAGE_PINS[pkg]);
      verdicts.push(verdict);
      findings.push(...verdict.findings);
    } catch (error) {
      if (!(error instanceof ScriptError)) throw error;
      findings.push({ ...error.toFinding(), at: `packages/${pkg}` });
    }
  }

  const ok = findings.length === 0;
  report(
    {
      ok,
      script: 'coverage-gate',
      summary: ok
        ? `${verdicts.length} package(s) at or above their bar — target ${COVERAGE_TARGET}%, ${Object.keys(COVERAGE_PINS).length} pinned`
        : `${findings.length} coverage finding(s) across ${verdicts.length} package(s)`,
      findings,
      data: verdicts.map((verdict) => verdict.reading),
    },
    json,
  );
}
