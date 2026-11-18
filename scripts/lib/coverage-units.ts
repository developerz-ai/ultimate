// What `scripts/coverage-gate.ts` gates and which of it one invocation runs: the units (every
// package, and `scripts/`), the flags, and the `--shard` split. Data and argv only — the
// measurement and the ratchet are the gate's.

// why: readFileSync — `unitsFor` is synchronous, and the weights are read once per invocation;
// `join` — Bun ships no path joiner.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadFlagError } from '../../packages/cli/src/errors';
import type { KnownFlags } from './args';
import { refuseUnknownFlags } from './args';
import { parseWeights, WEIGHTS_FILE } from './ci/test-weights';
import type { UnitPart } from './coverage-parts';
import { coverageFiles, PARTS_DIR, partName, planParts, unitOfName } from './coverage-parts';
import { unitWeight } from './coverage-schedule';

/**
 * One thing this gate measures alone: a package, or `scripts/`. `name` is what `--package` takes
 * and what `COVERAGE_PINS` is keyed by.
 */
export interface CoverageUnit {
  readonly name: string;
  /** What `bun test` is pointed at. */
  readonly test: string;
  /** What an `SF:` path of the unit's own source starts with, and what a finding's `at` names. */
  readonly source: string;
  /** The unit's own source files, as a glob from the repo root. */
  readonly glob: string;
}

/** The unit `scripts/` is: every guard and tool at the repo root, measured as one. */
export const SCRIPTS_UNIT: CoverageUnit = {
  name: 'scripts',
  // `./`, not the bare word: `bun test scripts` is a substring filter, and both tracked apps
  // carry a `scripts/` of their own.
  test: './scripts',
  source: 'scripts/',
  glob: 'scripts/**/*.ts',
};

/** `scripts` is the one unit that is not a package; every other name is `packages/<name>`. */
export const unitOf = (name: string): CoverageUnit =>
  name === SCRIPTS_UNIT.name
    ? SCRIPTS_UNIT
    : {
        name,
        // `./`, as `SCRIPTS_UNIT`: a bare `packages/mcp` is a substring filter to `bun test`, and
        // matched the tracked apps' own `packages/mcp` suites too.
        test: `./packages/${name}`,
        source: `packages/${name}/src/`,
        glob: `packages/${name}/src/**/*.{ts,tsx}`,
      };

/** Where a finding about the unit points: the directory, without the trailing slash. */
export const atOf = (unit: CoverageUnit): string =>
  unit.source.endsWith('/src/') ? unit.source.slice(0, -'/src/'.length) : unit.source.slice(0, -1);

/** Every unit `--all` gates, sorted: each workspace with a `src/`, and `scripts`. */
export function unitsToGate(root: string): readonly string[] {
  const packages = [...new Bun.Glob('packages/*/src').scanSync({ cwd: root, onlyFiles: false })];
  // Either separator: a Windows scan answers `packages\core\src`.
  return [...packages.map((path) => path.split(/[\\/]/)[1] as string), SCRIPTS_UNIT.name].sort();
}

/** The script as it is typed, for a refusal's `fix:`. */
const SELF = 'bun run scripts/coverage-gate.ts';

/** Every flag this script reads. Anything else is refused before a suite starts. */
export const COVERAGE_GATE_FLAGS = [
  'json',
  'package',
  'all',
  'jobs',
  'shard',
  'unit-timeout',
  'merge',
] as const;

const refuse = (flag: string, reason: string, fix: string): BadFlagError =>
  new BadFlagError({ flag, command: 'coverage-gate', reason, fix });

/** The flags the coverage gate reads; any other is refused, never dropped. */
const COVERAGE_KNOWN: KnownFlags = {
  names: COVERAGE_GATE_FLAGS,
  refuse: ([name = '']) => refuse(name, `unknown flag --${name}`, `${SELF} --all`),
};

/** How many test files `bun test <unit.test>` finds — what a unit is widened by (`workersFor`). */
export function testFileCount(root: string, unit: CoverageUnit): number {
  return testFilesOf(root, unit).length;
}

/** Every test file `bun test <unit.test>` finds, root-relative — what a timed-out unit is read against. */
export function testFilesOf(root: string, unit: CoverageUnit): readonly string[] {
  const base = unit.test.replace(/^\.\//, '');
  const files: string[] = [];
  for (const rel of new Bun.Glob(`${base}/**/*.{test,spec}.{ts,tsx}`).scanSync({ cwd: root })) {
    if (!rel.includes('/node_modules/')) files.push(rel);
  }
  return files;
}

/**
 * The committed per-file weights a unit's parts are cut by, or none. Unreadable is no weights, not
 * a refusal: every file then costs the same, which moves only the balance and the part count —
 * never a verdict — and `scripts/lib/ci/test-weights.test.ts` holds the committed file valid.
 */
export function readWeights(root: string): Readonly<Record<string, number>> {
  try {
    const parsed = parseWeights(JSON.parse(readFileSync(join(root, WEIGHTS_FILE), 'utf8')));
    return typeof parsed === 'string' ? {} : parsed.files;
  } catch {
    return {};
  }
}

/** How `name` is measured: one part (the whole unit), or the weight bands of `planParts`. */
export const unitPlan = (
  root: string,
  name: string,
  weights: Readonly<Record<string, number>> = readWeights(root),
): readonly UnitPart[] => planParts(name, coverageFiles(testFilesOf(root, unitOf(name))), weights);

/** Each unit as it is scheduled: its own name, or one `unit#i/n` per part when it is cut. */
export function scheduledNames(root: string, units: readonly string[]): readonly string[] {
  const weights = readWeights(root);
  return units.flatMap((name) => {
    const plan = unitPlan(root, name, weights);
    return plan.length === 1 ? [name] : plan.map(partName);
  });
}

/** What a scheduled name weighs when shards are dealt: a part is its unit's share. */
export const scheduledWeight = (name: string): number => {
  const total = /#\d+\/(\d+)$/.exec(name)?.[1];
  return unitWeight(unitOfName(name)) / (total === undefined ? 1 : Number(total));
};

/**
 * `--shard i/n`: the units this runner gates. Dealt heaviest first, each to the shard holding the
 * least weight so far (ties to the lowest index; equal weights by name), so every unit is in
 * exactly one shard and shard i is the same units on every runner. With every weight equal that
 * is round-robin over the SORTED list. Refused without `--all`: one named package has nothing to
 * split.
 *
 * Weighed, because round-robin over names put `cli`, `jobs`, `testing` and `entity` — four of the
 * five slowest units — in one shard: `packages (2/2)` 318-451 s against `(1/2)`'s 108-118 s
 * (runs 41965364111, 42032367633).
 */
export function shardUnits(
  units: readonly string[],
  raw: string,
  weight: (name: string) => number = () => 1,
): readonly string[] {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  const index = match === null ? Number.NaN : Number(match[1]);
  const total = match === null ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || index > total) {
    throw refuse(
      'shard',
      `--shard "${raw}" is not i/n with 1 <= i <= n`,
      `${SELF} --all --shard 1/2`,
    );
  }
  const sorted = [...units].sort();
  const weighed = new Map(sorted.map((name) => [name, weight(name)]));
  // A stable sort: equal weights keep name order.
  const order = [...sorted].sort((a, b) => (weighed.get(b) ?? 0) - (weighed.get(a) ?? 0));
  const loads = Array.from({ length: total }, () => 0);
  const owner = new Map<string, number>();
  for (const name of order) {
    let best = 0;
    for (let shard = 1; shard < total; shard += 1) {
      if ((loads[shard] as number) < (loads[best] as number)) best = shard;
    }
    loads[best] = (loads[best] as number) + (weighed.get(name) ?? 0);
    owner.set(name, best);
  }
  return sorted.filter((name) => owner.get(name) === index - 1);
}

/** The units this invocation gates, or a refusal naming the flag that was wrong. */
export function unitsFor(
  root: string,
  flags: ReadonlyMap<string, string | boolean>,
): readonly string[] {
  refuseUnknownFlags(flags, COVERAGE_KNOWN);
  const only = flags.get('package');
  const rawAll = flags.get('all');
  // A boolean given a value (`--all=false`) is refused, never read as off — `lib/args.ts`'s rule.
  if (typeof rawAll === 'string') throw refuse('all', '--all takes no value', `${SELF} --all`);
  const all = rawAll === true;
  const shard = flags.get('shard');
  const merge = flags.get('merge');
  if (merge !== undefined) {
    const fix = `${SELF} --merge ${PARTS_DIR}`;
    if (typeof merge !== 'string') {
      throw refuse('merge', '--merge takes the directory the shards wrote their parts to', fix);
    }
    if (only !== undefined || all || shard !== undefined) {
      throw refuse('merge', '--merge folds parts the shards measured and runs no suite', fix);
    }
    // The units that are cut: a whole unit was judged by the shard that ran it.
    const weights = readWeights(root);
    return unitsToGate(root).filter((name) => unitPlan(root, name, weights).length > 1);
  }
  if (typeof only === 'string' && all) {
    throw refuse('package', '--package and --all name two different runs', `${SELF} --all`);
  }
  if (typeof only !== 'string' && !all) {
    throw refuse(
      'all',
      only === true ? '--package takes a name' : 'name a unit with --package <name>, or pass --all',
      `${SELF} --all`,
    );
  }
  if (shard !== undefined && !all) {
    throw refuse(
      'shard',
      '--shard splits the --all list and does nothing for one package',
      `${SELF} --all --shard 1/2`,
    );
  }
  if (typeof only === 'string') return scheduledNames(root, [only]);
  const units = scheduledNames(root, unitsToGate(root));
  if (shard === undefined) return units;
  return shardUnits(units, typeof shard === 'string' ? shard : '', scheduledWeight);
}
