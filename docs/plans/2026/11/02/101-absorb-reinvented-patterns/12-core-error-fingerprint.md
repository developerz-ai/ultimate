# 12 — `errorFingerprint()`: one group for one fault

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`).

## Why
Two repositories built an error-to-issue loop (8,000 and 483 LOC). What they share below the business part is the grouping: which reports are the same fault.
`code` cannot answer it. Probe through `errorReport()`: two throws from one line reported `{"code":"X_INTERNAL","cause":"Error: row 1 missing"}` and `{"code":"X_INTERNAL","cause":"Error: row 2 missing"}`. On `code`, every unclassified throw in an app is one group; on `cause`, one group per row id. `core/src/error-reporter-sentry.ts:94` facets on `code` and sends no grouping key.

## Decisions
| Question | Answer |
|---|---|
| `errorIssueJob()` factory, forge port | no. Which forge, whether to reopen, how many per repository, who confirms a fix, are the two adopters' own different answers (axiom 8). `ErrorReporter` (`core/src/error-reporter.ts:66`) is the seam: an app's reporter enqueues its own job |
| Grouped-errors table and query | no. A framework table and a retention decision; the monitor or the app's job owns the store. Retention windows are app-chosen |
| Shape | a pure function, not a field. `ErrorReport` is a public interface; a required member breaks every hand-built report, an optional one every reader |
| Inputs | a coded fault: `code`, `source`, `scope.operation`. `X_INTERNAL`: those plus the top application frame. Never `cause`, `meta`, ids |
| Frame | function name and root-relative path, no line or column, so an edit above it keeps the group. First frame outside `node_modules` and `@ultimat3` |
| Across releases | stable by construction; `release` is not an input, so recurrence after a deploy is the same group |

## Files to change
- `packages/core/src/error-fingerprint.ts` (new) — `errorFingerprint(report: ErrorReport): string`, over `fingerprint()` (`core/src/canonical-json.ts:127`).
- `packages/core/src/exports/observability.ts:22` — export beside `reportError`. `packages/core/src/index.ts`.
- `packages/core/src/error-reporter-sentry.ts:94` — envelope carries `fingerprint: [errorFingerprint(report)]`.
- `docs/ops/03-observability.md:188`, `wiki/Observability.md`, `packages/core/README.md`, `packages/core/CLAUDE.md`. No `examples/dummy` use: a helper. Export from the observability seam only if the barrel's browser graph stays clean: `canonical-json.ts` reads `Bun.CryptoHasher`.

## Steps
1. Parse `report.stack` line by line, tolerating a missing stack (falls back to no frame).
2. Normalise: strip the working directory, drop `:line:col`, drop `file://`.
3. `fingerprint({ code, source, operation, frame })`, truncated to 16 hex characters.
4. The envelope. The monitor groups on it from then on: note the one-time regroup in `CHANGELOG.md`.

## Error codes
None. A pure function, total on any report. A stack it cannot parse gives the frameless fingerprint; it never throws, since it runs on the path that reports a failure.

## Tests
- `packages/core/src/error-fingerprint.test.ts` (unit): the probe's two throws agree; one extra line above the throw agrees; another function differs; another `code` differs; a coded error ignores its frame; a `node_modules` top frame is skipped; no stack does not throw; a throwing `stack` getter does not throw.
- `packages/core/src/error-reporter-sentry.test.ts`: envelope carries the same value.
- `bun test packages/core/src/error-fingerprint.test.ts`

## Semver
minor. New export. Envelope gains a field; an existing monitor regroups once.

## Done when
- Two throws differing only in a row id produce one fingerprint.
- `bun run verify` green.
