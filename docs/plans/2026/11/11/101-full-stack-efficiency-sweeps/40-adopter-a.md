# 40 — Adopter A

> Part of [`overview.md`](overview.md). **Edited from adopter A's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 30.0.0, `main`, ~1.5k LOC, scaffold with one action.

## Findings (read-only audit 2026-11-11)
- Island files excluded from coverage (the scaffolded `coverage.exclude`).
- Verify floor is 13 of 21 steps.

## Steps
1. `x upgrade` to the release carrying [`13`](13-cli-exercise-verify.md), [`14`](14-cli-commands-upgrade.md), [`13`](13-cli-exercise-verify.md); one major per run.
2. Delete the island `coverage.exclude` once [`13`](13-cli-exercise-verify.md) maps island coverage.
3. Accept the floor rows [`13`](13-cli-exercise-verify.md) adds for steps whose inputs exist; exclude one only with a reason.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- On the current release, exact pins, no island coverage exclude, gate green.

## Outcome (R)

`As of 2026-11-13`. On 31.22.0, exact pins (adopter PR #63; earlier #57, #58, #61, #62). Gate: 17 of 21 steps green, 4 skipped for lack of inputs (`live`, `job`, `e2e`, `roadmap`).

| Step | Outcome |
|---|---|
| 1 | done. Every shipped guard installed (the two report-only repo guards: 0 hits); the dead format hook replaced with the scaffold's |
| 2 | **owed, framework-blocked.** The island `coverage.exclude` stays: [`13`](13-cli-exercise-verify.md) X9 is deferred, and 31.22.0 still scaffolds the exclude (`SCAFFOLD_COVERAGE_EXCLUDE`) |
| 3 | done. `exercise`, `contract-diff`, `seo`, `i18n` floored (13 → 17 of 21) |
