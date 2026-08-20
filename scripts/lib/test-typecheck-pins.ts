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
// Cheapest first — this is the order phase 2 should be sliced in, one package per PR. The classes
// are the 2026-08-19 measurement and are advisory; the number is the rule:
//
// | Package | Errors | The classes behind the count |
// |---|---|---|
// | create-ultimate, money, seo | 0 | — |
// | i18n | 1 | TS2379 |
// | pwa | 2 | TS2741 |
// | schema | 2 | TS2339, TS2769 |
// | time | 2 | TS2741, TS2322 |
// | storage | 3 | TS2339, TS2769 |
// | db | 4 | TS18048, TS2769, TS2304, TS7006 |
// | auth | 5 | TS4111, TS2740, TS2769, TS2345 |
// | cache | 5 | TS2339, TS2352, TS4111 |
// | mail | 5 | TS2741, TS2339, TS2345 |
// | manifest | 5 | TS2379 |
// | ui | 6 | TS2353, TS2769 |
// | ai | 8 | TS2769, TS2339, TS2353 |
// | http | 8 | TS4111, TS2322, TS2375, TS2769 |
// | admin | 9 | TS2352, TS2722, TS2554, TS2322, TS2769, TS2304 |
// | core | 9 | TS2769, TS2345, TS2731, TS18046, TS2353 |
// | policy | 13 | TS2739 (fakes missing members the real interface gained), TS2322 |
// | query | 13 | TS2353, TS2345, TS2412 |
// | flags | 15 | TS2304 — one type used without its `import type`, fifteen times |
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
// Shrink it with `bun run scripts/test-typecheck-gate.ts --unpin <pkg>[,<pkg>]`, which lowers a
// count to what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-typecheck-pins.ts';

export const TEST_TYPECHECK_PINS: Readonly<Record<string, number>> = {
  action: 21,
  admin: 9,
  ai: 8,
  auth: 5,
  cache: 5,
  cli: 60,
  core: 9,
  'create-ultimate': 0,
  db: 4,
  entity: 78,
  flags: 15,
  http: 8,
  i18n: 1,
  jobs: 25,
  mail: 5,
  manifest: 5,
  mcp: 30,
  money: 0,
  policy: 13,
  pwa: 2,
  query: 13,
  realtime: 22,
  render: 48,
  schema: 2,
  scraping: 27,
  seo: 0,
  storage: 3,
  testing: 20,
  time: 2,
  ui: 6,
};

/** What this package is allowed to have failing today. Absent means zero, deliberately. */
export const pinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = TEST_TYPECHECK_PINS,
): number => pins[pkg] ?? 0;
