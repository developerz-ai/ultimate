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

## Outcome (R, in flight)

`As of 2026-11-13`. On 31.20.0, exact pins, deployed (adopter PRs #474, #476, #477, #481, #486, #488, #489; #490–#492 are unrelated maintenance, #493 open and unrelated). **The final round is in flight:** the page-window bug (E5), keyset (E4), three N+1s (E16) and one typed-handle slice (E1).

| ID | Outcome |
|---|---|
| E1 | owed. Row security off (`X_DB_ROW_SECURITY_OFF`: 715 raw statements name tenant tables); `repo-raw-sql` not installed; the first typed-handle slice is in the final round |
| E2 | owed. `X_EXERCISE_SEED_FAILED` on three tables (unique constraints need factory defaults); 155 of 487 primitives unproven (0.3183), no `exercise` floor |
| E3 | partial. The statement counts the audit named are no longer reported; two reads remain `X_STATEMENTS_OVER_BUDGET` (441 and 111) |
| E4 | in flight (final round) |
| E5 | in flight (final round) |
| E6 | owed |
| E7 | partial (#477). Five forms flagged `X_NATIVE_FORM_UNANSWERED` declare `native: nativeForm(…)`; the app's own form-answer wrapper is not deleted |
| E8 | owed. Candidates noted, not converted: each carries the app's own hashing and evidence logic |
| E9 | owed |
| E10 | owed |
| E11 | done by the upgrade: #474 moved to 31.8.0, which carries the [`01`](01-hotfix-patch.md) asset bucket; no app change. Not re-measured with a one-address load run |
| E12 | owed (not measured in this round) |
| E13 | owed (not measured in this round) |
| E14 | owed. Startup-probe delays set from the measured boot (web 8 s, sync 5 s) in [`30`](30-infra.md) I13; the idle heap, the preflight warnings and the boot gap untouched |
| E15 | owed |
| E16 | partial. 14 per-row reads fixed or declared bounded (#486, #488: one calendar read per term instead of one per year, 5 → 1 statements); three more in the final round |

Also adopted: `assets.retain` on the uploads disk (#477); `mountOver` for 47 islands and `maxPage` on 14 paged queries (#481); `unbounded-fanout` with two sites on `mapBounded` (#486); the framework's `isSessionRefusal` (#489, authenticator audited: not vulnerable).
