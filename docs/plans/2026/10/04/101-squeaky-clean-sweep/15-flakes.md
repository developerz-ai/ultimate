# 15 — Flaky tests: every one root-caused, none retried into green

> Part of [`overview.md`](overview.md). Added by the owner 2026-10-05: "fix all the flaky tests, and
> their root causes". **Sweep 8d**, after 8b. Read-only investigation over 300 `ci` runs
> (2026-09-26 → 10-05): 26 runs where attempt 1 failed and the same commit passed on a rerun.

## Rule
A flake is a defect with a cause. The fix removes the cause: a deadline that is wrong is made
right, shared state is isolated, a race is ordered. Never a retry, never padding a timeout that is
already right. Each fix carries the test or the stress loop that proves it.

## Findings → fix

| # | Occurrences | Root cause | Fix | Proof |
|---|---|---|---|---|
| F1 | 4, still live (37369367050, 36818504621, 36732526536, 36263967271) | Browser hooks allow 60 s (`packages/cli/e2e/client-navigation-fixture.ts:405`, comment out of date), but the open they wrap is designed to take up to `LAUNCH_TIMEOUT_MS × LAUNCH_ATTEMPTS` (2 × 60 s, `testing/src/cdp-launch.ts:100,108`) plus three 30 s CDP handshakes. Bun kills the hook before the designed relaunch, so `X_CDP_LAUNCH_FAILED` never names the slow step. Load comes from `coverage-gate.ts:324` running 4 coverage processes, and `packages/cli` launching a fresh Chrome in each of 8 browser suites | Export one `E2E_BROWSER_OPEN_MS` from `@ultimat3/testing`, derived from the launch and CDP constants; every browser hook uses it (`client-navigation-fixture.ts`, `service-worker.e2e`, `cdp-shot.e2e`, `ui-as-prop.e2e`, `testing/e2e/cdp-browser.e2e`, `cdp-session.e2e`); the four `client-navigation-*` suites share one browser, one tab each | a test that every browser hook's deadline ≥ the open budget (reads the suites); a stress loop of shard 2/2 under 4-CPU load |
| F2 | 3 runs, 18 jobs | GitHub never acquired a hosted runner ("not acquired … even after multiple attempts"); the job shows `cancelled` and `verify` reports a missing shard. Infra, not code | `verify merge` names a part whose job never STARTED apart from one that died. `ci.yml` concurrency: `cancel-in-progress` only on attempt 1, so `gh run rerun` of an older run never cancels a newer one | merge test for the message; workflow-shape test for the concurrency expression |
| F3 | 1 (windows) | `launchChrome` over the port reported `why: 'closed'` after Chrome printed "DevTools listening"; the attempt record drops the underlying error (`testing/src/cdp-launch-attempt.ts:174`) | Carry the dial or handshake error in the attempt's failure and the `X_CDP_LAUNCH_FAILED` cause, so the next occurrence is diagnosable, then fix what it names | unit test: a failing dial's message reaches the cause |
| F4 | every red run | `verify` writes the whole verdict to `$GITHUB_STEP_SUMMARY` (`ci.yml:268-270`), over GitHub's 1024 KiB limit on a red run ("upload aborted"), so the evidence is lost | Write the step table plus the first N findings, and a pointer to the artifact | size test on a synthetic red verdict |
| F5 | 1 (c918bcad) | `examples/dummy/imports.test.ts` finds "every module" by glob plus a deny-list; a new entry-point directory (`bin/`) was imported and RAN | Use the file set `x dev` boots (the app module scan), not a glob | the test fails if a script under `bin/` is reachable |
| — | 9 + 2 + 1 + 1 + 11 | `stale build offers a reload` (X_CDP_TIMEOUT), cold Chrome announce, taken-port IPv4/IPv6, `prepareStackTrace` leak, one-offs before 10-03 | Already fixed (b054a307, 781a6b0d, d7bd8d15 and rewrites); no recurrence since | — |

## Done when
- F1–F5 fixed with their proofs; `bun run verify` and the app gate are green; merged.
