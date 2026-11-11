# 41 — Adopter B

> Part of [`overview.md`](overview.md). **Edited from adopter B's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 30.0.0, `main`, ~55k LOC.

## Findings (read-only audit 2026-11-11)
- Per-id delete loop: `deleteWhere` is equality-only (fleet events repository).
- A terminal served as a long-poll action: no duplex byte stream.
- Two set-aside embedded data directories under `.x/` that would not open.
- Shipped guards never installed (`repo-raw-sql` and others; ~18 files).

## Steps
1. `x upgrade`; accept the report-only guard install from [`14`](14-cli-commands-upgrade.md), then burn the baseline down.
2. Range delete through the chain terminal from [`05`](05-entity.md) (~2 files).
3. Replace the hand-rolled bounded pool in `scripts/` with `mapBounded` ([`02`](02-schema-core.md)).
4. Terminal: adopt the outcome of owner decision OD4 in [`90`](90-owner-decisions.md) (duplex channel or stays long-poll).
5. Delete the set-aside data directories after [`14`](14-cli-commands-upgrade.md)'s `X_DEV_DATA_UNOPENABLE` path is proven on a fresh boot.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- No per-id write loop under an `expectedQueryLoop`; every shipped guard installed; gate green.
