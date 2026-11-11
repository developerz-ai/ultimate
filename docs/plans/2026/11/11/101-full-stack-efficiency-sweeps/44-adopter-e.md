# 44 — Adopter E

> Part of [`overview.md`](overview.md). **Edited from adopter E's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 31.2.0, `main`, ~438k LOC, deployed.

## Findings (read-only audit 2026-11-11)
| # | Finding | Framework slice |
|---|---|---|
| E1 | 100% raw SQL: 1,453 `sql` literals, 0 typed-handle calls, 377 hand-written tenant predicates, 51 `crossTenant(` | [`05`](05-entity.md), [`14`](14-cli-commands-upgrade.md) |
| E2 | Exercise proofs void: 487/487 scale verdicts `unproven` (the sized seed hits a unique violation), 57 tenant `unproven` | [`13`](13-cli-exercise-verify.md) |
| E3 | One staff read issues 14,892 statements, one gauge job 14,868, four reads 259–441 | [`13`](13-cli-exercise-verify.md) |
| E4 | Hand keyset SQL, 56 importers | `keyset()` exists (`packages/db/src/index.ts:138`) |
| E5 | Hand page-window source: page two of a 20-row window was empty | [`08`](08-action-query.md) |
| E6 | Safety re-read island, 115 lines | `pollEvery()` (`packages/realtime/src/query-poll.ts:17`), [`02`](02-schema-core.md) backoff default |
| E7 | Native form answer wrapper: 277 lines, 261 calls in 134 files, plus a middleware | [`08`](08-action-query.md) |
| E8 | 7 upload request/confirm action pairs | [`08`](08-action-query.md) `uploadFlow` |
| E9 | 42 task + companion-job pairs | [`09`](09-jobs.md) `cronJob` |
| E10 | 15 `pg_advisory_xact_lock` literals | [`05`](05-entity.md) `lockKeys` |
| E11 | 429 on island chunk requests from the fifth route on; 74% 429 in a one-address load run | [`01`](01-hotfix-patch.md) asset bucket |
| E12 | Local gate dies in `unit` at 1,336 s; the app rebuilt CI's shard plan by hand | [`13`](13-cli-exercise-verify.md) `x verify --parts` |
| E13 | `CHROME_PATH` from `.env.development.local` is scrubbed from test children | [`13`](13-cli-exercise-verify.md) |
| E14 | Production: each role idles at 250–320 Mi (4–5× the demo); boot 7.7–9.1 s with a 4–6 s silent gap after the app preflight; boot warnings repeated in every role; scheduler and sync above their memory requests | this slice + [`30`](30-infra.md) |
| E15 | Two append-only tables read with payload filters and no expression index (20,305 sequential scans on one) | [`05`](05-entity.md) expression index |
| E16 | Per-row lookups in loops (four by-id readers called per row) | batched reads, ~20 files |

## Steps
1. `x upgrade` to the release carrying [`01`](01-hotfix-patch.md) first: it removes the chunk 429s with no app change.
2. E2: fix the sized-seed unique violation so scale proofs run; then E3, largest first (~8 files).
3. E1: turn on `database.rowSecurity`; install `repo-raw-sql` report-only with its baseline; adopt the typed handle slice by slice (1 config file, then ~120 repositories over several PRs, ≤ 100 files each).
4. E4 → `keyset()` (~58 files, one PR). E5 after [`08`](08-action-query.md).
5. E6, E7, E8, E9, E10: delete each wrapper once its mechanism ships (~5 / ~135 / ~14 / ~84 / ~15 files; E7 and E9 are two PRs each).
6. E14: profile the idle heap of one role (`x profile`, [`14`](14-cli-commands-upgrade.md)); move the three preflight warnings to the web role; find the 4–6 s boot gap.
7. E15: declare the expression indexes; E16: batch the four readers.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- Exercise: 0 `unproven` above the recorded floor; no primitive over the statement budget without a stated reason.
- `repo-raw-sql` baseline strictly lower in every PR; row security on.
- No hand keyset, safety re-read, form-answer, upload pair or sweep pair left.
- Gate green locally through `x verify --parts`.
