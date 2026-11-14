# 46 — Adopter G

> Part of [`overview.md`](overview.md). **Edited from adopter G's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 30.2.0, `main`, ~321k LOC.

## Findings (read-only audit 2026-11-11)
- Hand keyset SQL for one listing; a 365-line per-run tally rewritten in every writer's transaction; own heartbeat and lost-run sweep; a 301-line error-reporter wrapper (scrub, drop by code, fingerprint); own bounded work queue; own `gate-parity` guard.
- 70 tenant proofs `unproven` in exercise; `exercise`, `job`, `live` not in the verify floor.
- Exercise index advice misfires on three query shapes (its field report §26, never filed upstream).
- 63 `count(*)`, 33 `group by` in raw SQL.

## Steps
1. `x upgrade`.
2. `keyset()` for the listing (~3 files); chain update terminal ([`05`](05-entity.md), ~4 files).
3. Drop the heartbeat and lost-run sweep for `args.lease` + re-driven `onSettled` ([`09`](09-jobs.md), ~6 files).
4. Drop the reporter wrapper for `sentryErrorReporter({ scrub, drop, fingerprint })` ([`02`](02-schema-core.md)); the work queue for `mapBounded`; the guard for the shipped `gate-parity` ([`13`](13-cli-exercise-verify.md)).
5. Add `exercise`, `job`, `live` to the floor; clear the 70 tenant-unproven (~20 files).
6. Hand the three §26 shapes to the framework as failing fixtures for [`13`](13-cli-exercise-verify.md).
7. Tally: adopt `rollup()` derive-on-write if owner decision OD5 ships it.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- No hand-rolled lease, keyset, reporter wrapper or pool; floor includes every step whose inputs exist; 0 tenant-unproven above the floor; gate green.

## Outcome (R)

`As of 2026-11-13`. On 31.22.0, exact pins, deployed (adopter PR #1059; earlier #1006, #1007, #1008, #1010, #1022, #1048). Gate green: 19 steps, `live` and `roadmap` not applicable.

| Step | Outcome |
|---|---|
| 1 | done. The two report-only repo guards installed. `repo-unbounded` found a real bug: a bare `.all()` stopped at 50 step events, so every failed run after the 50th never reached the line-suspect rule — now `.inBatches(1_000)`, with a 55-run test red on the old code. Three per-row write loops made one statement each; two declared `expectedQueryLoop`. 34 await-in-loop warnings left, each checked as already-chunked or a bounded retry. `error-declared` withheld: 185 findings, its own PR |
| 2 | **framework gap.** `keyset()` refuses nullable sort keys and mints its own cursor; the listing pages over nullable keys with cursors already in URLs |
| 3 | closed in writing. The "heartbeat" is a worker presence beat, not a job lease; the lost-run sweep settles domain rows by bank timeout. Neither is `args.lease` + `onSettled` |
| 4 | reporter: already on `sentryErrorReporter({ … })` before this round. Work queue: **framework gap** — named lanes, a deadline reserve and a result per item; `mapBounded` rejects on the first failure. `gate-parity`: **falsified premise** — the framework ships no `gate-parity` template (none in `packages/cli/src`) |
| 5 | partial. `job`, `exercise` (`unprovenMax` 0.5442), `contract-diff`, `seo`, `i18n` floored. The 73 tenant-unproven queries stand: every entity is global, and no declaration exists for a global read — **framework gap** |
| 6 | done earlier: the three shapes are framework fixtures since 31.17.0 |
| 7 | closed by OD5 (deferred); `rollup()`'s scheduled buckets do not match a per-run row rewritten in the writer's transaction |

Owed: `error-declared`; three framework gaps (nullable `keyset()` keys and caller cursors, a settle-all `mapBounded`, a global-read declaration for tenant proofs).
