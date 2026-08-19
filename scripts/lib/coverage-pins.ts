// The coverage bar every package must clear, and the packages allowed to sit under it today.
// Data only: `scripts/coverage-gate.ts` owns what the ratchet does with it. Split out for the
// reason `gated-apps.ts` is split out — the pins are the part a human edits, and every landed
// test deletes a line here.

/** Where the pins live, so `X_COVERAGE_PIN_STALE` can name the file to edit. */
export const PINS_FILE = 'scripts/lib/coverage-pins.ts';

/**
 * Line and function coverage a package's own `src/` must reach. One number for all 30: a
 * per-package target negotiated downward is not a bar, it is a record of what happened.
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
 * Measured `As of 2026-08-19`: 12 of 30 packages clear the target, 18 are pinned.
 * Re-measure with `bun run scripts/coverage-gate.ts --all --json`.
 */
export const COVERAGE_PINS: Readonly<Record<string, CoveragePin>> = {
  admin: {
    lines: 79.47,
    funcs: 84.97,
    why: 'the widest surface with the fewest tests: resource/mcp projection is covered, the screen and frame builders are not',
  },
  auth: { lines: 94.05, funcs: 93.53, why: 'oauth provider branches need a live issuer' },
  cli: {
    lines: 92.25,
    funcs: 93.53,
    why: '11,890 lines, the largest package: command wiring is covered, several interactive paths are not',
  },
  db: {
    lines: 98.23,
    funcs: 92.03,
    why: 'lines clear the bar; the pg client halves are live-only',
  },
  i18n: {
    lines: 95.15,
    funcs: 92.59,
    why: 'lines clear the bar; several extract helpers are unreached',
  },
  jobs: {
    lines: 91.19,
    funcs: 91.8,
    why: 'the pg driver halves are live-only, so they measure 0 without TEST_DATABASE_URL',
  },
  mail: {
    lines: 96.52,
    funcs: 92.59,
    why: 'lines clear the bar; the smtp socket half needs a peer',
  },
  manifest: {
    lines: 96.81,
    funcs: 93.9,
    why: 'lines clear the bar; several docs-scan helpers are unreached',
  },
  mcp: { lines: 92.97, funcs: 86.23, why: 'transport-stdio and the wire framing need a peer' },
  money: {
    lines: 95.8,
    funcs: 90.43,
    why: 'lines clear the bar; several rounding-mode branches have no direct case',
  },
  pwa: {
    lines: 90.96,
    funcs: 85.45,
    why: 'the emitted sw.js is executed against stubs, but several strategy branches are unreached',
  },
  realtime: {
    lines: 95.14,
    funcs: 94.18,
    why: 'lines clear the bar, functions do not — the nats transport is fake-only here',
  },
  render: {
    lines: 93.41,
    funcs: 95.04,
    why: 'hydrate and modes are covered; the island runtime paths are not',
  },
  scraping: {
    lines: 89.34,
    funcs: 84.96,
    why: 'the cdp driver paths need a browser; the fake and fixture drivers carry the parity suite',
  },
  seo: {
    lines: 92.18,
    funcs: 94.59,
    why: 'sitemap and robots are covered; several meta renderers have no case',
  },
  testing: {
    lines: 92.11,
    funcs: 92.28,
    why: 'fixtures are exercised BY other suites rather than having their own',
  },
  time: {
    lines: 94.6,
    funcs: 88.67,
    why: 'cron-parse is covered; several instant/format helpers have no direct case',
  },
  ui: {
    lines: 87.44,
    funcs: 82.49,
    why: 'components render through jsx-probe; the 51 stylesheets and several presentational components have no case',
  },
};

/**
 * Paths inside a package's `src/` that do not count toward its own coverage.
 *
 * `icons/glyphs/` is 23,073 lines of GENERATED data — `build-icons.ts` writes one module per
 * Lucide glyph, each an array literal. Counting them measures the generator's output volume, not
 * the package's tested surface: they would move `@ultimat3/ui`'s denominator by an order of
 * magnitude while saying nothing about whether a component works.
 */
export const COVERAGE_EXCLUDED = ['/icons/glyphs/'] as const;
