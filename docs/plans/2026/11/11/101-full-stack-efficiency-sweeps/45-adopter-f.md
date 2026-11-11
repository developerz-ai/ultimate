# 45 — Adopter F

> Part of [`overview.md`](overview.md). **Edited from adopter F's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: `^19.1.0` (lock 19.1.3), `main`, ~17k LOC, dormant since 2026-09.

## Findings (read-only audit 2026-11-11)
- 12 majors behind; no typed handle; 4 guards.

## Steps
1. Nothing unless the owner revives it (decision OD9 in [`90`](90-owner-decisions.md)). If revived: `x upgrade` one major per run, 19 → 31, gate green at each hop.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- Either recorded as dormant in [`90`](90-owner-decisions.md), or on the current release with the gate green.
