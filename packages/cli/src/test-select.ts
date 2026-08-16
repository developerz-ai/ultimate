// Decides which files `x test` runs: discovery, the `--filter`/type/`--sample` narrowing, and the
// validation behind the type positional and `--sample`. Selection only — nothing here splits a
// shard or spawns a process, so a wrong file list is always this file's bug and never a race.

// Bun ships no equivalent: `join` builds the host-separator path from the scan root to a hit.
// Sizing is Bun's own (`Bun.file().size`), so nothing here reaches for `node:fs`.
import { join } from 'node:path';
import { BadFlagError } from './errors';
import type { ParsedArgs } from './parse';
import { flagString, nearest } from './parse';
import type { TestType } from './verify-tests';
import { TEST_TYPES, typeFiltersOf } from './verify-tests';

export interface TestFile {
  readonly path: string;
  readonly bytes: number;
}

/**
 * `.tsx` too. A JSX test was silently outside the gate's parallel steps — `discoverTests` never
 * yielded it, so `runParallel` spawned `bun test` over an explicit file list that did not include
 * it and the step reported green over a file that never executed, while `bun run test` at the root
 * ran it and failed. `testStepCommand`'s own ignore patterns already say `.test.*`.
 */
const TEST_GLOB = '**/*.test.{ts,tsx}';

/**
 * The root `test` script's ignore list, kept identical so `x test` and `bun run test` see one
 * suite. `e2e/` is NOT on it: an opt-in suite that the gate runs but `x test` silently drops is
 * a suite nobody runs until CI says so. `examples/` is, because the reference app is a separate
 * project with its own gate — `x verify` there, not `x test` here.
 *
 * `dummy/` and `build/` complete the list `verify-tests.ts` already excluded (`NEVER_A_TEST`). The
 * comment above claimed the two agreed and they did not: `x test unit` discovered 464 files where
 * the gate's `unit` step ran 441, so the gate's own test steps — which now select through this
 * function — would have started running a nested demo app's suite on the framework's gate.
 *
 * Both directories are gated where they belong, by `scripts/reference-app-gate.ts` running
 * `x verify` inside each app — see `NEVER_A_TEST` for why that is the only place they run.
 */
const IGNORED = ['/dist/', '/build/', '/node_modules/', '/examples/', '/dummy/'];

/**
 * File size stands in for duration: cheap to read, and it correlates far better than file count.
 * `type`, when given, narrows to exactly the files verify-tests.ts would run for that suite — see
 * `belongsToType` below, the one place that rule is decided.
 */
export async function discoverTests(
  root: string,
  filter?: string,
  type?: TestType,
): Promise<readonly TestFile[]> {
  const files: TestFile[] = [];
  for await (const found of new Bun.Glob(TEST_GLOB).scan({ cwd: root, absolute: false })) {
    const path = found.split('\\').join('/');
    if (IGNORED.some((part) => `/${path}`.includes(part))) continue;
    if (filter !== undefined && !path.includes(filter)) continue;
    if (type !== undefined && !belongsToType(path, type)) continue;
    files.push({ path, bytes: Bun.file(join(root, path)).size });
  }
  return files;
}

// Not localeCompare: its ordering depends on the machine's locale, and the split must not.
export const bySizeThenPath = (a: TestFile, b: TestFile): number =>
  b.bytes - a.bytes || (a.path > b.path ? 1 : -1);

/**
 * `--sample`'s deterministic slice, reusing the same (size desc, path asc) order `planShards`
 * relies on for sharding — never a random sample, so a rerun keeps the same N files. It exists for
 * the eval loop: that suite is the slowest one, and an agent iterating on a prompt needs a fast
 * partial signal long before the full type finishes. That is exactly why a sampled run is NOT a
 * gate — a pass over the first N files says nothing about the files left out, which is why the
 * result names what actually ran (`cli.test.sampled`, `data.sample`) instead of a plain pass that
 * reads like the whole type went green.
 */
export function sampleFiles(files: readonly TestFile[], sample: number): readonly TestFile[] {
  return [...files].sort(bySizeThenPath).slice(0, sample);
}

type TypeFilter = readonly [Exclude<TestType, 'unit'>, readonly string[]];

let cachedFilters: readonly TypeFilter[] | undefined;

/**
 * verify-tests.ts owns the one definition of what a file's test type is; `typeFiltersOf` is that
 * table's own accessor. Re-declaring the suffixes here would be a second definition, and the two
 * would drift the first time a suite's naming rule changed.
 *
 * Built lazily, and that is load-bearing: verify-tests.ts imports this module (the gate's test
 * steps select their files through `discoverTests`), so the two form a cycle. A module-scope
 * `const` reading `TEST_TYPES` evaluates during import, inside the other module's temporal dead
 * zone, and whichever side is imported first dies with "Cannot access 'TEST_TYPES' before
 * initialization" — measured by `bun run manifest`, which imports the CLI and took the crash.
 */
const typeFilters = (): readonly TypeFilter[] => {
  cachedFilters ??= TEST_TYPES.filter(
    (type): type is Exclude<TestType, 'unit'> => type !== 'unit',
  ).map((type) => [type, typeFiltersOf(type)] as const);
  return cachedFilters;
};

const matchesAny = (path: string, filters: readonly string[]): boolean =>
  filters.some((filter) => path.includes(filter));

/** unit is everything the five typed suites do not claim, so no file falls between two types. */
export function belongsToType(path: string, type: TestType): boolean {
  if (type === 'unit') return typeFilters().every(([, filters]) => !matchesAny(path, filters));
  return typeFilters().some(([typed, filters]) => typed === type && matchesAny(path, filters));
}

/**
 * The positional now means exactly one thing — one of the six test types — a deliberate breaking
 * change from the old free-text filter positional. `undefined` means "every type," today's
 * whole-suite behaviour, unchanged.
 */
export function readType(raw: string | undefined): TestType | undefined {
  if (raw === undefined) return undefined;
  const known: readonly string[] = TEST_TYPES;
  if (known.includes(raw)) return raw as TestType;
  const suggestion = nearest(raw, known);
  throw new BadFlagError({
    flag: 'type',
    command: 'test',
    reason: `"${raw}" is not a test type (known: ${TEST_TYPES.join(', ')})`,
    fix: suggestion === undefined ? `x test ${TEST_TYPES[0]}` : `x test ${suggestion}`,
  });
}

/**
 * `--sample` exists for the eval loop: it is the slowest suite, and an agent iterating on a prompt
 * needs a fast partial signal long before the full type finishes. A sampled run is therefore NOT a
 * gate — the caller has to be told it ran a subset, which is why a sampled result carries its own
 * summary line and `data.sample` instead of quietly reporting a subset as if it were everything.
 */
export function readSample(args: ParsedArgs): number | undefined {
  const raw = flagString(args, 'sample');
  if (raw === undefined) return undefined;
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(value) || value < 1) {
    throw new BadFlagError({
      flag: 'sample',
      command: 'test',
      reason: `expects an integer >= 1, got "${raw}"`,
      fix: 'x test eval --sample 5',
    });
  }
  return value;
}

/** The selection, as `NoTestFilesError` wants it: only the parts the caller actually asked for. */
export function missingSelection(
  type: TestType | undefined,
  filter: string | undefined,
): { type?: TestType; filter?: string } {
  return {
    ...(type === undefined ? {} : { type }),
    ...(filter === undefined ? {} : { filter }),
  };
}
