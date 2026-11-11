# 43 — Adopter D

> Part of [`overview.md`](overview.md). **Edited from adopter D's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: `^30.0.0` (the only caret pins in the fleet), `main`, ~21k LOC, spec only: zero primitives declared.

## Findings (read-only audit 2026-11-11)
- Caret ranges on every `@ultimat3/*` dependency (~19 `package.json` lines).

## Steps
1. `x upgrade`; exact pins (`X_UPGRADE_MIXED_PINS` already refuses carets).

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- Exact pins on the current release; gate green.
