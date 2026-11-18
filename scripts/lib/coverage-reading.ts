// One unit's coverage READING out of an lcov report: the records scoped to the unit's own source,
// the source files no record names, and `scripts/`'s rule that counts those at zero. The verdict on
// a reading is the gate's (`scripts/coverage-gate.ts`); how parts fold is `coverage-parts.ts`.

// why: readFileSync — the unimported-source scan is synchronous (`Bun.file().text()` is async
// only); `join` — Bun ships no path joiner.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLcov, percent } from '../../packages/cli/src/coverage-lcov';
import {
  hasExecutableCode,
  TEST_FILE,
  unloadedWeight,
} from '../../packages/cli/src/coverage-source';
import { COVERAGE_EXCLUDED } from './coverage-pins';
import type { CoverageUnit } from './coverage-units';
import { SCRIPTS_UNIT, unitOf } from './coverage-units';

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

/** Whether an `SF:` path is `name`'s own source — what a part document keeps of its lcov. */
export const ownSourceOf =
  (name: string) =>
  (file: string): boolean =>
    isOwnSource(unitOf(name), file);

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

/** A unit's reading from its lcov: scoped, its unrecorded sources named, `scripts/`'s counted. */
export function readingOf(root: string, name: string, lcov: string): CoverageReading {
  const scoped = { ...scopeLcov(lcov, name), unimported: unimportedSources(root, name, lcov) };
  return unitOf(name) === SCRIPTS_UNIT ? withUnloadedCounted(root, scoped, lcov) : scoped;
}
