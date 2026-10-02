// What `scripts/coverage-gate.ts` gates and which of it one invocation runs: the units (every
// package, and `scripts/`), the flags, and the `--shard` split. Data and argv only — the
// measurement and the ratchet are the gate's.

import { BadFlagError } from '../../packages/cli/src/errors';

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
        test: `packages/${name}`,
        source: `packages/${name}/src/`,
        glob: `packages/${name}/src/**/*.{ts,tsx}`,
      };

/** Where a finding about the unit points: the directory, without the trailing slash. */
export const atOf = (unit: CoverageUnit): string =>
  unit.source.endsWith('/src/') ? unit.source.slice(0, -'/src/'.length) : unit.source.slice(0, -1);

/** Every unit `--all` gates, sorted: each workspace with a `src/`, and `scripts`. */
export function unitsToGate(root: string): readonly string[] {
  const packages = [...new Bun.Glob('packages/*/src').scanSync({ cwd: root, onlyFiles: false })];
  return [...packages.map((path) => path.split('/')[1] as string), SCRIPTS_UNIT.name].sort();
}

/** The script as it is typed, for a refusal's `fix:`. */
const SELF = 'bun run scripts/coverage-gate.ts';

/** Every flag this script reads. Anything else is refused before a suite starts. */
export const COVERAGE_GATE_FLAGS = ['json', 'package', 'all', 'jobs', 'shard'] as const;

const refuse = (flag: string, reason: string, fix: string): BadFlagError =>
  new BadFlagError({ flag, command: 'coverage-gate', reason, fix });

/**
 * `--shard i/n`: the units this runner gates — round-robin over the SORTED list, so every unit is
 * in exactly one shard and shard i is the same units on every runner. Refused without `--all`:
 * one named package has nothing to split.
 */
export function shardUnits(units: readonly string[], raw: string): readonly string[] {
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
  return [...units].sort().filter((_, position) => position % total === index - 1);
}

/** The units this invocation gates, or a refusal naming the flag that was wrong. */
export function unitsFor(
  root: string,
  flags: ReadonlyMap<string, string | boolean>,
): readonly string[] {
  for (const name of flags.keys()) {
    if ((COVERAGE_GATE_FLAGS as readonly string[]).includes(name)) continue;
    throw refuse(name, `unknown flag --${name}`, `${SELF} --all`);
  }
  const only = flags.get('package');
  const all = flags.get('all') === true;
  const shard = flags.get('shard');
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
  if (typeof only === 'string') return [only];
  const units = unitsToGate(root);
  return shard === undefined ? units : shardUnits(units, typeof shard === 'string' ? shard : '');
}
