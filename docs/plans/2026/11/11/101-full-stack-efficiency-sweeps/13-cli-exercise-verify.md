# 13 — cli: an exercise step that cannot go green on nothing, and one gate plan for laptop and CI

> Part of [`overview.md`](overview.md). Depends on: [`05`](05-entity.md) (the write terminals its fix text names), [`07`](07-auth-policy.md) P1 (the scope-parity finding lands here). Tier: 5 (`cli`, `testing`).

One large adopter: 487 of 487 scale verdicts `unproven` from a single seed unique violation, one read issuing 14,892 statements in one call, and a green gate. The tracked apps: no route `load` is ever exercised.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| X1 | P1 | confirmed (read) | `packages/testing/src/scale-sweep-run.ts:102-109` | One sized-seed write failure marks **every** subject `unproven` with the same reason and emits no finding of its own | one finding for the seed failure naming entity and constraint (`X_EXERCISE_SEED_FAILED`); retry the sized seed for the other entities; mark `unproven` only the subjects that read the failed entity (`scale-sweep-graph.ts` knows the tables) |
| X2 | P2 | confirmed (read); by decision until now | `packages/cli/src/exercise-findings.ts:147-160` | `unproven` is never red | red when unproven ÷ reached exceeds `exercise.unprovenMax` in `x.verify.json` (default 0 for a new app; `x upgrade` writes the app's measured figure as its ratchet, which may only fall). `X_EXERCISE_UNPROVEN_ABOVE_FLOOR` |
| X3 | P1 | confirmed (`.x/exercise.json` of both tracked apps) | `packages/cli/src/cmd-exercise.ts`; `packages/testing/src/exercise.ts` | Exercise runs actions, queries and jobs, never a route `load`: page reads are unmeasured (the demo's `/messages` at 4 + N statements passes unseen). A primitive reached with 0 statements and 0 effects counts as proven "flat" (17 of 85 in the reference app) | each `app/` and `site/` route's `load` runs under the seed with the same statement, plan and scale proofs (params from `exercise.ts` overrides or a declared sample). "Reached, 0 statements, 0 effects" is a finding unless an override says why: `X_EXERCISE_EMPTY_REACH` |
| X4 | P2 | confirmed (read) | `packages/testing/src/scale-sweep-run.ts:75-79`, `exercise.ts:401-406` | Statements are tallied per call, but only *growth* is judged. No absolute ceiling | default ceiling per primitive call (100), `statements: { max, why }` override in `defineExercise`. `X_STATEMENTS_OVER_BUDGET`, its fix listing the top three shapes by count |
| X5 | P2 | confirmed (read) | `packages/testing/src/exercise.ts:392-406`, `seed-graph-pass.ts:183`; `packages/cli/src/exercise-database.ts:107` | The scratch database is re-migrated every run; the seed grows with primitive count (122 s for 504 primitives); primitives run strictly in sequence (219 s) | (a) snapshot the migrated scratch database by migration hash (`pglite-snapshot.ts` `snapshotDir`, `template-db.ts` on Postgres); (b) with a fixed `--seed`, cache the seeded graph keyed by schema hash + seed + count; (c) `x exercise --shard i/n` across processes — tenant pairs are already disjoint |
| X6 | P2 | confirmed (read) | `packages/cli/src/templates/github/ci.yml.ts:46-63`; `wiki/CI-Parallel-Gate.md:11-24` | The scaffolded CI is one job. The parts are wiki prose and a hand-written matrix in this repo's `ci.yml`. No plan file both the CLI and a workflow read: one adopter rebuilt the shard plan and wrote its own parity guard; its local `unit` step died at 1,336 s | `x verify plan --parts <n> --json` emits the matrix (only, shard, services) from `VERIFY_STEP_NAMES` + `SHARDABLE_STEPS` + `verify-shard.ts` timings; the scaffold workflow reads it through `fromJSON`; `x verify --parts <n>` runs the same plan locally, part by part, and merges; `x verify merge` checks a run against the plan. The framework's own `ci.yml` adopts it in [`16`](16-gate-ci-docker.md) |
| X7 | P2 | confirmed (read) | `packages/cli/src/test-dotenv.ts:76-89` (rule at `:1-19`) | The scrub deletes any key whose value equals what `.env.development(.local)` sets: `CHROME_PATH` and `PUPPETEER_EXECUTABLE_PATH` (`browser-launcher.ts:14`) vanish from test children; e2e cannot find the browser | an allowlist of host-locator keys (`BROWSER_PATH_VARS`, `TMPDIR`) that never change app behaviour |
| X8 | P2 | gap; 6 adopters at 13 of 21 steps | `x.verify.json` `steps`; the framework root has the check (`scripts/verify.test.ts:276`) | The floor is opt-in per step: apps with an `exercise.ts` and job tests skip `exercise`, `job`, `live`, `e2e` | a step whose inputs exist (`VERIFY_STEPS[].applies`) is in the floor unless `x.verify.json` excludes it with a `why`. `X_VERIFY_STEP_UNFLOORED`. On `main`: a doctor finding and an upgrade-report line; red by default waits on `next` |
| X9 | P3 | plausible | `packages/cli/src/templates/scaffold-verify-floor.ts:63-67`; `island-bundle.ts:229` (`sourcemap: 'external'`); `coverage-lcov.ts` | Every scaffold excludes `*.island.tsx` from coverage ("Bun cannot map that chunk back"), 5 adopters carry it | remap chunk records through the external map inside `coverage-lcov.ts`, drop the scaffolded exclude; `X_COVERAGE_EXCLUDE_STALE` when an exclude matches a measurable file |
| X10 | P3 | plausible | `packages/cli/src/verify-checks.ts:249,294,465` | drift, contract-diff, budgets and manifest each call `loadApp` | memoise `appManifest` per `runVerify`, keyed on a tree stamp |
| X11 | P3 | open adopter report (never filed) | `packages/testing/src/plan-oracle.ts` | Exercise index advice misfires on three query shapes | adopter G hands over the three shapes as failing fixtures ([`46`](46-adopter-g.md)); fix against them |
| X12 | P3 | gap; 3 adopters | new guard template | `Promise.all(rows.map(async … db …))` over an unbounded list | shipped guard `unbounded-fanout`, fix text names `mapBounded` ([`02`](02-schema-core.md) C8). And the `repo-raw-sql` guard's fix text gains two cases: a hand row-comparison names `keyset()`, a `pg_advisory_xact_lock` literal names `lockKeys` |

## Files to change
- `packages/testing/src/scale-sweep-run.ts`, `scale-sweep-graph.ts`, `exercise.ts`, `exercise-judge.ts`, `define-exercise.ts`, `seed-graph-pass.ts` — X1, X3, X4, X5.
- `packages/cli/src/cmd-exercise.ts`, `exercise-findings.ts`, `exercise-database.ts`, `exercise-routes.ts` (new), `verify-floor.ts` — X2, X3, X5, X8.
- `packages/cli/src/verify-plan.ts` (new), `verify-merge.ts`, `cmd-verify-spec.ts`, `templates/github/ci.yml.ts` — X6. `wiki/CI-Parallel-Gate.md`.
- `packages/cli/src/test-dotenv.ts` — X7. `coverage-lcov.ts`, `templates/scaffold-verify-floor.ts` — X9. `verify-checks.ts` — X10.
- `packages/cli/src/templates/guard-unbounded-fanout.ts` (new), `templates/guard-repo-raw-sql.ts`, `templates/scaffold-guards.ts` — X12.
- `examples/dummy/x.verify.json`, `exercise.ts` and the two other tracked apps' — the new floor and budgets ([`18`](18-tracked-apps.md) fixes what they reveal; this slice only records the expected-red rows in `scripts/lib/gated-apps.ts` if a finding cannot be fixed in the same PR).
- Coordinator only: six codes through `bun run new-error-code … --package cli --off-socket`, changelog + `wiki/Upgrading.md` (X2 and X4 turn new findings red in upgraded apps: the ratchet figure is written by `x upgrade`), `bun run manifest`.

## Steps
1. Sweep 13a: X1, X2, X4, X7, X10 (small, independent). Sweep 13b: X3 (routes), X5, X6, X9, X12.
2. X3 will turn the tracked apps red. That is the point; fix order is [`18`](18-tracked-apps.md). Land 13b and the app fixes in one PR, or record each expected-red row with its issue.
3. X6: write the plan emitter against this repo's existing matrix first — its output must reproduce today's `ci.yml` parts exactly (`ci-workflow-shape.test.ts` is the oracle).
4. X2/X4 defaults: a new app gets 0 and 100. An upgraded app gets its measured figures as a ratchet. Never a silent green.

## Tests
- `packages/testing/src/scale-sweep-run.test.ts` — one entity's unique violation: one finding, the other subjects judged.
- `packages/cli/src/exercise-findings.test.ts` — all-unproven is a finding; 20 statements against a max of 10 is red; an empty reach is red, an override with `why` is not.
- `packages/cli/src/exercise-routes.test.ts` — a loop in a route `load` is reported with the route's file.
- `packages/cli/src/verify-plan.test.ts` — the union of the plan's parts is the step list, each step exactly once; the scaffolded workflow's matrix equals `x verify plan --json`.
- `packages/cli/src/test-dotenv.test.ts` — `devOnlyLeakedKeys` keeps `CHROME_PATH`.
- `packages/cli/src/coverage-lcov.test.ts` — a mounted island's handler counts against its `.island.tsx`.
- Determinism: a cached seed gives byte-identical records.
- Command: `bun test ./packages/cli/src/<file>.test.ts`.

## Done when
- An app whose sized seed fails gets one red finding, not a green gate.
- Every route `load` in the three tracked apps is exercised; none over budget without a stated `why`.
- `x verify --parts 4` on the reference app equals CI's verdict; the scaffolded workflow carries no hand-written matrix.
- Exercise on a 500-primitive app under half of 341 s (adopter E re-measures, [`44`](44-adopter-e.md)).
