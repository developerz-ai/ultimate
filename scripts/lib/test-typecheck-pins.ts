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
// What is left: **nothing**. The ratchet reads zero across every workspace `As of 2026-08-25`.
//
// The last two were `packages/entity/src/pg-driver.test.ts`, and this comment recorded them as one
// named defect with a route already mapped: `Repo`'s full-row write members took the ROW type where
// money's WRITE type belongs, so `Repo.insert(values: T)` demanded a `MoneyValue` while
// `narrowMoney` exists solely to narrow a `bigint` handed to a driver — a compile error on public
// API, since `postgresRepo()` is exported. `RowWrite<Row>` plus narrowing at each write-method
// entry is what closed it, which is the third route this comment described and the one it said
// would work.
//
// The diagnosis in it was right and the *cause* named here was not: this file assumed the runtime
// had to be met halfway. Measured instead — `Bun.SQL` hands `int8` back as a **string**, never a
// `bigint`, and `decodeRow` re-parses it — so the read path never met one, the write path already
// narrowed, and the runtime was correct in both directions. Only the declaration was wrong. Fixing
// the TEST, which is what a reader would have done, would have deleted a capability the framework
// documents, implements and stores correctly.
//
// 448 errors closed across 30 workspaces, and fifteen of them were
// the type being wrong rather than the test:
//
// | Where | What shipped |
// |---|---|
// | `i18n/context.ts` | `LocaleSources` refused the `undefined` its own sibling reader produces |
// | `policy/test-kit.ts` | `testActor()` minted an `Actor` with no `kind`/`scopes`, so `hasScope()` threw out of a predicate |
// | `query/source.ts` | `RowProvider` forbade the synchronous thunk `execute` has always awaited |
// | `http/error-map.ts` | `ERROR_STATUS` was typed open in the one table whose argument is that it is closed |
// | `scraping/session-state.ts` | `isCookie` claimed `value is ScrapeCookie` after checking 2 of 6 fields |
// | `scraping/http.ts`, `ai/*.ts` | `fetch?: typeof fetch` — an option no caller could fill, 13 double casts deep |
// | `realtime/rebase.ts` | `rebaseFrame` declared the whole union and built one member |
// | `jobs/driver-memory.ts` | `close` optional on a driver that always implements it |
// | `entity/types.ts` | `RowPatch` could not spell `{ col: undefined }` — the exact value `X_WRITE_UNFILTERED` exists to refuse |
// | `entity/repo.ts` | `findById(id, { includeDeleted })` was honoured at runtime and a type error |
// | `cli/templates/index.ts` | the barrel exported a union and one of its three members |
// | `realtime/presence.test.ts` | a `Transport` built by spreading a class instance — no prototype, no `publish` |
// | `jobs/step-options.test.ts` | a two-arg `waitForEvent` call put `{ timeout }` on the `event` parameter |
//
// Two constraints this program imposes that nothing else does. `tsconfig.tests.json` is a SINGLE
// program, so a `declare module` in a `.test.ts` is globally visible — write an augmentation in
// `packages/testing/src/matcher-surface.ts` or a `.d.ts`, never in a test. And a fixture module
// under `src/` is subject to the coverage gate, so every export in one must be reachable from a
// test or it reads as `X_COVERAGE_UNMEASURED`.
//
// Shrink it with `bun run scripts/test-typecheck-gate.ts --unpin <pkg>[,<pkg>]`, which lowers a
// count to what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-typecheck-pins.ts';

// Every package reached zero, so every row went: absent means zero, and thirty `pkg: 0` rows read
// as thirty waivers still in force over nothing.
export const TEST_TYPECHECK_PINS: Readonly<Record<string, number>> = {};

/** What this package is allowed to have failing today. Absent means zero, deliberately. */
export const pinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = TEST_TYPECHECK_PINS,
): number => pins[pkg] ?? 0;
