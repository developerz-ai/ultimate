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
