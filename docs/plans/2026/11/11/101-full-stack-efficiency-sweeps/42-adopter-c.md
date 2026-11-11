# 42 — Adopter C

> Part of [`overview.md`](overview.md). **Edited from adopter C's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 30.0.0, `main`, ~4.8k LOC.

## Findings (read-only audit 2026-11-11)
- Own `scripts/dev/affected.ts`, `scripts/gh/*`, `scripts/dev/shot.ts`: the CLI ships `x affected`, `x pr`, `x ci`, `x shot`.
- No `guards/` directory at all.
- Coverage floor 68%.

## Steps
1. `x upgrade`; accept the guard install ([`14`](14-cli-commands-upgrade.md)).
2. Delete the three script families; call the CLI commands (~10 files).
3. Raise the coverage floor to the measured figure after the island mapping ([`13`](13-cli-exercise-verify.md)).

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- No script duplicating a CLI command; guards installed; gate green.
