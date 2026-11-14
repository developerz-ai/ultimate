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

## Outcome (R)

`As of 2026-11-13`. On 31.22.0, exact pins (adopter PR #89; earlier #83, #84, #87, #88). Gate: 20 of 21 steps green, `roadmap` skipped.

| Step | Outcome |
|---|---|
| 1 | done but one: the two report-only repo guards installed, the one hit (a five-statements-per-host cascade) made a set write, 0 boundary warnings left. `error-declared` is withheld: 78 hand-written `UltimateError` subclasses to move onto `defineError`, its own PR |
| 2 | done. Three per-id write loops are set writes; their three `expectedQueryLoop` waivers deleted; `statements` fixtures pin the write shapes |
| 3 | done. The hand-rolled pool in `scripts/` deleted for `mapBounded`; the pool test proves the same behaviour on it. Difference stated: `mapBounded` stops starting items after the first rejection (every caller already catches per item) |
| 4 | closed by OD4: the terminal stays long-poll |
| 5 | mechanism proven on a fresh boot (`X_DEV_DATA_UNOPENABLE` sets an unopenable directory aside). The two old directories are gitignored and live only in the owner's checkout: **owner-owed** `rm -rf` of both |

Also floored: `exercise` (ratchet `unprovenMax` 0.5455, 12 of 22), `contract-diff`, `seo`, `i18n`.

Owed: `error-declared` installed; the owner's directory delete.
