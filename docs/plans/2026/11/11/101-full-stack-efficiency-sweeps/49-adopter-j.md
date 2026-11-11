# 49 — Adopter J

> Part of [`overview.md`](overview.md). **Edited from adopter J's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 28.0.0, ~57k LOC under `console/` of an infrastructure-tooling repository; two checkouts on disk, both on feature branches.

## Findings (read-only audit 2026-11-11)
- Three majors behind.
- Own safety re-read (114 lines, a near-copy of adopter E's).
- A sealed secret had to be renamed: its name collided with one the framework's CDN purge reads.
- 3 task + job pairs; island coverage exclude.

## Steps
1. Work in a git worktree off `main`: both checkouts are the owner's.
2. `x upgrade` 28 → 29 → 30 → 31, gate green at each hop.
3. Safety re-read → `pollEvery()`; pairs → `cronJob` ([`09`](09-jobs.md)); exclude removed after [`13`](13-cli-exercise-verify.md).
4. Run `x env check` ([`14`](14-cli-commands-upgrade.md)): no app secret on a reserved name.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- On the current release; no hand-rolled re-read; gate green.
