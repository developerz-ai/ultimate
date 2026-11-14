# 48 — Adopter I

> Part of [`overview.md`](overview.md). **Edited from adopter I's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 30.0.0, `main`, ~5k LOC, thin UI over a native engine.

## Findings (read-only audit 2026-11-11)
- Island coverage exclude; floor is 13 steps.

## Steps
1. `x upgrade`; remove the exclude after [`13`](13-cli-exercise-verify.md); accept the floor rows from [`13`](13-cli-exercise-verify.md).

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- Current release, no island exclude, gate green.

## Outcome (R)

`As of 2026-11-13`. On 31.22.0, exact pins (adopter PR #40; earlier #34, #35, #38, #39). Gate: 19 of 21 steps green, no findings; `live` and `roadmap` not applicable.

| Step | Outcome |
|---|---|
| upgrade | done. All 25 shipped guards present; the two report-only repo guards: 0 hits. Both dead format hooks replaced, the C++ one rewritten the same way |
| exclude | **owed, framework-blocked.** [`13`](13-cli-exercise-verify.md) X9 deferred; `X_COVERAGE_EXCLUDE_STALE` does not exist; removing the exclude would fail the 95 % floor on files no test can map |
| floor | done. 13 → 19 steps: `job`, `exercise` (`unprovenMax` 0.3334), `contract-diff`, `seo`, `i18n`, `e2e` |
