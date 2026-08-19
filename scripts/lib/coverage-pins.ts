// The coverage bar every package must clear, and the packages allowed to sit under it today.
// Data only: `scripts/coverage-gate.ts` owns what the ratchet does with it. Split out for the
// reason `gated-apps.ts` is split out — the pins are the part a human edits, and every landed
// test deletes a line here.

/** Where the pins live, so `X_COVERAGE_PIN_STALE` can name the file to edit. */
export const PINS_FILE = 'scripts/lib/coverage-pins.ts';

/**
 * Line and function coverage a package's own `src/` must reach. One number for all 30: a
 * per-package target negotiated downward is not a bar, it is a record of what happened.
 *
 * **This number is a FLOOR, and it is not the bar.** Coverage measures execution, not
 * validation — 100% is reachable with zero assertions, and the well-documented failure of a
 * coverage KPI is a team that raised its number by writing tests that assert nothing. A run
 * mutation-tested after such a push scored 3% against a reported 30%.
 *
 * So the rule this repo holds itself to, and the one that makes the number mean anything:
 *
 * > **Every test added to raise coverage must be proven by mutation** — break the source it
 * > covers, watch the test go red, restore. A branch covered by a test that cannot fail is worse
 * > than an uncovered branch, because it reads as done.
 *
 * That is not enforceable by this gate and is deliberately written here rather than left implied:
 * the 26 packages that reached this bar on 2026-08-19 did so under roughly 300 applied mutations,
 * five of which initially SURVIVED and were closed. If a future push raises a package without
 * that evidence, the number will be true and worthless.
 */
export const COVERAGE_TARGET = 95;

/**
 * How far above its pin a package may drift before the pin is stale. A pin is a claim about
 * today; left alone it becomes a ceiling nobody notices they are under. Narrow enough that a
 * real improvement trips it, wide enough that adding one uncovered line to a large package does
 * not fail the build twice in one commit.
 */
export const PIN_SLACK = 1.5;

/**
 * **Every number below is measured with NO live services.** `bun test packages/<pkg>` with no
 * `TEST_DATABASE_URL`, no Redis and no NATS skips every `*.live.test.ts`, so the pg halves of
 * `db` and `jobs`, the smtp half of `mail` and the nats half of `realtime` measure as unreached.
 *
 * That is deliberate and the CI job must match it: coverage has to be the same number on a
 * laptop and on a runner, or a pin is a claim nobody can reproduce and `X_COVERAGE_PIN_STALE`
 * fires on a runner for work nobody did. The live paths are not untested — `x verify`'s `live`
 * step runs them against a real Postgres; they are simply not what this gate measures.
 */

export interface CoveragePin {
  /** Line coverage this package is at today, as a percentage of its own `src/`. */
  readonly lines: number;
  /** Function coverage this package is at today. */
  readonly funcs: number;
  /** What is uncovered and who owns closing it. Deleted, never edited downward. */
  readonly why: string;
}

/**
 * Packages below `COVERAGE_TARGET`, each pinned at what it measures today. A package ABSENT from
 * this table must clear the target — that is what makes the gate blocking while the last few are
 * still being written. Both directions fail: under the pin is a regression, and comfortably over
 * it is a pin that has outlived its reason.
 *
 * **Empty `As of 2026-08-19`, and that is the ratchet reaching its end**: all 30 packages clear
 * 95% lines and 95% functions on their own `src/`, so there is nothing left to excuse. It started
 * at 18 pinned with `admin` lowest at 77.93%.
 *
 * A new entry here is a regression that someone chose not to fix yet, and it needs the reason
 * written in `why`. Re-measure with `bun run scripts/coverage-gate.ts --all --json`.
 */
export const COVERAGE_PINS: Readonly<Record<string, CoveragePin>> = {};

/**
 * Paths inside a package's `src/` that do not count toward its own coverage.
 *
 * `src/bin.ts` is an executable entry point — a shebang, a top-level `await` and a
 * `process.exit(code)`. Importing it from a test runs the CLI against the TEST RUNNER's own argv
 * (`bun test packages/cli` parses as `x test packages/cli`, spawning a nested suite) and then
 * kills the runner. Everything it does lives in `dispatch.ts`, which is covered.
 *
 * `src/preload.ts` is the bunfig preload. The runner loads it once per process before any test
 * file, so it is never imported BY a test and cannot appear in a report a test produced.
 *
 * A `type-pins` module exists to fail `tsc`, not to run: it asserts type-level facts a test file
 * could never check, because `tsconfig.json` excludes test files from the build and a type
 * assertion written in one is never read by the compiler. `x verify`'s `typecheck` step is its
 * gate, and the only one that can be.
 *
 * `icons/glyphs/` is 23,073 lines of GENERATED data — `build-icons.ts` writes one namespace per
 * Lucide glyph, each an array literal. Counting them measures the generator's output volume, not
 * the package's tested surface: they would move `@ultimat3/ui`'s denominator by an order of
 * magnitude while saying nothing about whether a component works.
 */
export const COVERAGE_EXCLUDED = [
  '/icons/glyphs/',
  '/src/bin.ts',
  '/src/preload.ts',
  '/type-pins.',
] as const;
