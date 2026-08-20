// The ratchet under `scripts/test-typecheck-gate.ts`: how many `tsc` errors each package's OWN
// tests carry today. The number may FALL and may never rise. Data only — the gate owns what it
// does with these, and this is the part a human edits: every landed fix lowers a line here.
//
// Measured 2026-08-19, `tsc -p tsconfig.tests.json`: 446 errors over 161 files in 27 packages.
// `create-ultimate`, `money` and `seo` are pinned at 0 from the start, so an error in one of them
// fails the gate the day it arrives. A package with no line here is pinned at 0 too — a new
// package's tests typecheck, or its first `x verify` says so.
//
// A COUNT, not a list of diagnostics, for the reason `scripts/readme-fences-backlog.ts` gives
// about its own: a pin keyed on a file and a line goes stale on every edit to the file above it,
// and churn teaches a reader to regenerate a ratchet without looking at it.
//
// Cheapest first — this is the order the remaining packages should be sliced in, one PR per
// batch. The classes are the 2026-08-19 measurement and are advisory; the number is the rule:
//
// | Package | Errors | The classes behind the count |
// |---|---|---|
// | testing | 20 | TS2339, TS2353, TS2322, TS2345 |
// | action | 21 | TS4111, TS2353, TS2322, TS2769 |
// | realtime | 22 | TS2769, TS2339, TS2741, TS2353 |
// | jobs | 25 | TS2722, TS7006, TS4111, TS2741 |
// | scraping | 27 | TS4111, TS2741, TS2554 |
// | mcp | 30 | TS2345, TS4111, TS2339, TS2739 |
// | render | 48 | TS2379 (`exactOptionalPropertyTypes`), TS2322, TS2345, TS2739 |
// | cli | 60 | TS2345, TS2769, TS2322, TS18046 |
// | entity | 78 | TS4111 (index-signature access), TS2769, TS18048 |
//
// At zero and staying there: `create-ultimate`, `money`, `seo` (never had a line), plus the 18
// closed by the first phase-2 batch — `core`, `schema`, `i18n`, `time`, `pwa`, `storage`, `db`,
// `cache`, `flags`, `auth`, `http`, `policy`, `query`, `mail`, `manifest`, `ui`, `ai`, `admin`.
// 115 errors, and four of them were the type being wrong rather than the test: `LocaleSources`
// refused the `undefined` its own sibling reader produces, `testActor()` minted an `Actor` with no
// `kind` and no `scopes` so `hasScope()` threw out of a predicate, `RowProvider` forbade the
// synchronous thunk `Builder.execute` has always awaited, and `ERROR_STATUS` was typed open in the
// one table whose whole argument is that it is closed.
//
// Shrink it with `bun run scripts/test-typecheck-gate.ts --unpin <pkg>[,<pkg>]`, which lowers a
// count to what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-typecheck-pins.ts';

export const TEST_TYPECHECK_PINS: Readonly<Record<string, number>> = {
  action: 21,
  admin: 0,
  ai: 0,
  auth: 0,
  cache: 0,
  cli: 59,
  core: 0,
  'create-ultimate': 0,
  db: 0,
  entity: 78,
  flags: 0,
  http: 0,
  i18n: 0,
  jobs: 25,
  mail: 0,
  manifest: 0,
  mcp: 30,
  money: 0,
  policy: 0,
  pwa: 0,
  query: 0,
  realtime: 22,
  render: 48,
  schema: 0,
  scraping: 27,
  seo: 0,
  storage: 0,
  testing: 20,
  time: 0,
  ui: 0,
};

/** What this package is allowed to have failing today. Absent means zero, deliberately. */
export const pinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = TEST_TYPECHECK_PINS,
): number => pins[pkg] ?? 0;
