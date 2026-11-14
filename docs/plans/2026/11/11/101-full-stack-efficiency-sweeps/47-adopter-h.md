# 47 — Adopter H

> Part of [`overview.md`](overview.md). **Edited from adopter H's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 30.6.0, `main`, ~160k LOC.

## Findings (read-only audit 2026-11-11)
- Three repositories write per id: `updateWhere` has no `in`.
- Two own lease + heartbeat + stale-sweep sets (agent runs, flow engine).
- Own audit group-commit wrapper, own per-request memo, own bounded pool ("the entity layer takes no signal"), own sorted advisory-lock helper.
- `exercise` not in the floor.
- Open field reports: media generation in the AI gateway, `x token`, job debounce/expiry/priority, per-run bounds that raise a ceiling.

## Steps
1. `x upgrade`.
2. Chain terminals in the three repositories ([`05`](05-entity.md), ~3 files).
3. Drop both lease sets after [`09`](09-jobs.md) (~8 files).
4. Drop the audit wrapper for `postgresAuditSink({ groupCommit: true })` ([`08`](08-action-query.md)); the memo for `memoPerRequest` ([`04`](04-cache-seo.md)), the pool for `mapBounded` ([`02`](02-schema-core.md)); the lock helper for `lockKeys` ([`05`](05-entity.md)).
5. `exercise` in the floor.
6. Adopt `x token` ([`14`](14-cli-commands-upgrade.md)) and job debounce/expiry ([`09`](09-jobs.md)) where the app works around them.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- None of the five wrappers left; `exercise` in the floor; gate green.

## Outcome (R)

`As of 2026-11-13`. On 31.22.0, exact pins, deployed (adopter PR #144; earlier #135, #138, #141, #142, #143). Gate green in parts: 16 floor steps in 99 s, `exercise` alone in 374 s.

| Step | Outcome |
|---|---|
| 1 | done. The two report-only repo guards installed; 17 await-in-loop and 7 unbounded findings fixed, 0 boundary warnings left. Four reads that stopped at 50 rows were bugs (one left a 51st child key live after a cascade revoke; one could delete bytes still in use). `error-declared` withheld: 218 subclasses in 54 files, its own PR |
| 2 | done. Per-id writes are chain terminals (`updateAll`, `deleteAll`, `upsertAll`, `updateMany`); a `statements` test pins ≤ 3 statements per mention batch where the old loop sent 40 for 20 |
| 3 | closed in writing. Both lease sets fence writes into domain rows and outlive one job attempt; `args.lease` holds one attempt's job row, and `lost()` cannot fence a database write |
| 4 | audit group commit: wrapper deleted for `postgresAuditSink({ executor, groupCommit: true })`, its tests ported. The port found a **framework defect**: the batch timer inherited the arming writer's transaction, so a rollback lost other writers' rows. Fixed upstream by framework PR #1127 (merged, unreleased); the app holds a 4-line `outsideTransactions` shim until then. Memo: **framework gap** — `memoPerRequest` has no `forget` and no hold time. Pool: done, over `mapBounded`, the per-task verdict kept. Lock helper: kept; the move to `lockKeys` changes the lock identity, so it is a two-release deploy (both locks, full rollout, then drop the legacy one), its own PR |
| 5 | done. `exercise`, `contract-diff`, `seo`, `i18n` floored |
| 6 | closed in writing. `x token` would change the app's key format and MCP auth model (product decision); the app's debounce and expiry are domain-row mechanisms, not job-queue workarounds |

Owed: delete the `outsideTransactions` shim once framework 31.22.1 ships (#1127); the `lockKeys` migration PR with its deploy plan; `error-declared`; the `memoPerRequest` gap. `renameProject` declares `statements: { max: 140 }` (106 measured) until the entity layer has an expression update.
