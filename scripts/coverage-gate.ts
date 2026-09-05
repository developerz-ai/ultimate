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

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { finiteOption } from '@ultimat3/core';
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

/**
 * Whether a file holds anything that could be EXECUTED, as opposed to a barrel that only
 * re-exports. The distinction is load-bearing: bun emits no lcov record for a file with no
 * executable statement, so a pure barrel is legitimately absent — and a real module nobody
 * imported is absent for the opposite reason and must not pass as one.
 *
 * Comments and `import`/`export … from '…'` statements are stripped; anything left is code.
 */
/** Index just past the balanced `{ … }` that starts at or after `from`. */
function skipBalanced(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * Index just past the `;` that ends a `type` alias — the first one at nesting depth zero.
 *
 * Depth matters and a naive scan gets it wrong: `type _A = Assert<[FactKeysOf<{ a: 1 }>] extends
 * [Actor] ? true : false>;` contains a `{ … }` whose closing brace is NOT the end of the
 * declaration, and matching braces there leaves `, ] extends [Actor] … >;` behind, which then
 * reads as executable code.
 */
function endOfTypeAlias(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')' || ch === '>') depth -= 1;
    else if (ch === ';' && depth <= 0) return i + 1;
  }
  return text.length;
}

/**
 * Whether a file emits anything at RUNTIME, as opposed to a barrel or a types-only module.
 *
 * Load-bearing, not cosmetic: bun writes an lcov record only for a file that produced executable
 * code, so a pure barrel and a types-only module are legitimately absent — while a real module
 * nothing imported is absent for the opposite reason and must be reported.
 * `packages/core/src/type-pins.ts` says it of itself: "This module emits nothing and exports
 * nothing anybody imports."
 *
 * A regex cannot decide this. `metrics-types.ts` contains `(() => number)` in a TYPE position, so
 * scanning for `=>` calls a types-only file executable. Hence a scanner: strip comments and
 * re-export statements, then remove `interface` blocks by brace matching and `type` aliases to
 * their depth-zero `;`, and ask whether anything is left.
 *
 * `declare module` and `declare global` are removed the same way, and for the same reason the
 * `declare const` line above exists: an ambient block emits nothing at runtime, so bun writes no
 * lcov record for a file built only from one. Their bodies go with them — an augmentation's
 * members are declarations whatever they look like. Without this, `matcher-surface.ts` (a
 * `declare module 'bun:test'` and nothing else) read as executable and was reported as a real
 * module no test imports, which is the opposite of what it is.
 */
export function hasExecutableCode(source: string): boolean {
  let text = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*(?:import|export)\b[^;]*?from\s*'[^']*';[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s+type\b[^;]*;[ \t]*$/gm, '')
    // `declare const x: T;` is ambient — it emits nothing, and `type-pins.ts` files are built
    // almost entirely from them.
    .replace(/^[ \t]*declare\s+(?:const|let|var|function|class)\b[^;]*;[ \t]*$/gm, '');

  // Ambient blocks first: their bodies hold `interface` members that the loop below would strip
  // individually, leaving a bare `declare module '…' { }` shell behind that reads as code.
  for (;;) {
    const ambient = /(?:^|\n)[ \t]*declare\s+(?:module\s+'[^']*'|global)\s*\{/.exec(text);
    if (ambient === null) break;
    const start = ambient.index + (ambient[0].startsWith('\n') ? 1 : 0);
    text = text.slice(0, start) + text.slice(skipBalanced(text, text.indexOf('{', start)));
  }

  for (;;) {
    const found = /(?:^|\n)[ \t]*(?:export\s+)?(?:declare\s+)?(interface|type)\s/.exec(text);
    if (found === null) break;
    const start = found.index + (found[0].startsWith('\n') ? 1 : 0);
    const end =
      found[1] === 'interface'
        ? skipBalanced(text, text.indexOf('{', start))
        : endOfTypeAlias(text, start);
    text = text.slice(0, start) + text.slice(end);
  }
  return text.replace(/\s/g, '') !== '';
}

export interface CoverageReading {
  readonly pkg: string;
  readonly lines: number;
  readonly funcs: number;
  /** Lines found in the package's own `src/`. Zero is the false green this gate refuses. */
  readonly measured: number;
  /**
   * Source files with executable code that lcov has no record of at all. They are NOT zeroes in
   * the percentage — bun records a file only when something imports it, so a module no test
   * reaches is absent from both halves of the fraction and silently makes the number BETTER.
   * `@ultimat3/ui` had 16 of these, and its denominator grew from 2,922 to 3,286 lines the day
   * they were first imported.
   */
  readonly unimported: readonly string[];
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
  // `startsWith`, NOT `includes`. Bun writes `SF:` paths relative to the repo root, and both
  // tracked apps carry a package of their own under the same name —
  // `examples/dummy/packages/mcp/src/` and `dummy/social-media-clone/packages/mcp/src/` each
  // CONTAIN `packages/mcp/src/`. A substring test folded them into the framework package's
  // reading: `@ultimat3/mcp` measured 96.99% while its own sources were at 100%, carrying 35
  // uncovered lines that belong to an app gated on its own ratchet.
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
        file.startsWith(prefix) &&
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
  return { pkg, lines: pct(lh, lf), funcs: pct(fnh, fnf), measured: lf, unimported: [] };
}

/**
 * An `SF:` path as a path relative to `root`, which is the only form a glob result can be compared
 * against. Bun writes them root-relative; an absolute one and a `./`-prefixed one are normalised
 * rather than matched by suffix.
 *
 * `endsWith('/' + rel)` was the compare, and it re-introduced the exact collision `scopeLcov` has a
 * paragraph about one screen above: both tracked apps carry `packages/<name>/src/`, so the app's
 * `examples/dummy/packages/mcp/src/mcp.ts` ENDS WITH `/packages/mcp/src/mcp.ts` and answered for
 * the framework file of that name. A framework module no suite imports then read as recorded, and
 * `X_COVERAGE_UNIMPORTED` — the check whose whole job is to notice a file no test ever loads — went
 * quiet for every name an app happens to share.
 */
const rootRelative = (root: string, file: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  return file.startsWith('./') ? file.slice(2) : file;
};

/** Every non-test source file under the package that has executable code and no lcov record. */
export function unimportedSources(root: string, pkg: string, lcov: string): readonly string[] {
  const recorded = new Set(
    lcov
      .split('\n')
      .filter((line) => line.startsWith('SF:'))
      .map((line) => rootRelative(root, line.slice(3))),
  );
  const missing: string[] = [];
  for (const rel of new Bun.Glob(`packages/${pkg}/src/**/*.{ts,tsx}`).scanSync({ cwd: root })) {
    if (/\.test\.[cm]?[jt]sx?$/.test(rel)) continue;
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

  if (reading.unimported.length > 0) {
    findings.push({
      code: 'X_COVERAGE_UNMEASURED',
      at,
      cause: `${reading.unimported.length} file(s) under packages/${reading.pkg}/src/ have executable code and NO lcov record, so they are absent from the percentage rather than counted as zero: ${reading.unimported.slice(0, 5).join(', ')}${reading.unimported.length > 5 ? ', …' : ''}`,
      fix: `import each of them from a test beside it — a file nothing reaches makes this package's coverage read HIGHER, which is the one direction an unmeasured file must never move it`,
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
  // `--isolate`, the flag `x test` runs every suite under (`packages/cli/src/test-shards.ts`), and
  // for the same reason: a module realm per file. Without it every file of a package shares one
  // process, and a process has ONE lifecycle — the second in-process boot of `x dev` or `serveApp`
  // is refused (`X_LIFECYCLE_DRAINED`, `X_READINESS_CHECK_DUPLICATE`), so whichever boot file the
  // filesystem listed first was measured and every later one failed in silence, subtracting its
  // coverage. Measured 2026-09-05 on `packages/cli`: 94.94% on a GitHub runner against 95.73% on a
  // laptop whose `readdir` happened to list the files the other way round. Same numbers on every
  // disk is what a ratchet needs. The lcov report is one file either way.
  const proc = Bun.spawn(
    [
      'bun',
      'test',
      '--isolate',
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
  const lcov = await file.text();
  const reading = { ...scopeLcov(lcov, pkg), unimported: unimportedSources(root, pkg, lcov) };
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
