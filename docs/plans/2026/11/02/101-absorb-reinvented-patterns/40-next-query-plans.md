# 40-next-query-plans — A statement no index can serve fails the build, with zero rows

> Part of [`overview.md`](overview.md). Depends on: [`40-next-exercise-pass.md`](40-next-exercise-pass.md). Tier: 2 (`entity`), 5 (`testing`, `cli`).

## Why
Agent-written apps work on 200 rows and fall over on 2 million, and nothing says so until production. A plan on a test database proves little: on few rows the planner prefers a scan, so plan checks need volume, and volume needs minutes. Probed 2026-11-02 on PGlite (Postgres 18.6), empty tables, `explain (generic_plan, format json)` under `enable_seqscan`, `enable_bitmapscan`, `enable_sort` all off:

| Statement | Plan |
|---|---|
| `where org_id=$1 order by created_at desc, id desc limit 20` | `Limit > Index Scan[posts_org_created]` |
| `where author_id=$1`, no index | `Seq Scan(posts)` |
| `where post_id=$1` on an unindexed foreign key | `Seq Scan(comments)` |
| `where org_id=$1 order by title limit 20` | `Limit > Sort > Index Scan` |
| `where created_at>$1 order by created_at desc limit 20`, tenant column not first | `Limit > Sort > Index Scan` |
| `where id=$1` | `Index Scan[posts_pkey]` |

Those settings make the planner pick a scan or sort only when nothing else can answer: **a deterministic oracle, independent of row count and statistics.** It reads the schema's capability, not a cost guess.
Existing: the `statements` fixture catches an N+1 only in a test that names it (`testing/src/fixture-statements.ts:1`); `cli/src/dev-n-plus-one.ts` warns in a dev server; `20-cli-db-diagnostics.md` reads production after the fact.
Hard to match: needs the statement set of an app nobody wrote tests for, which the exercise pass supplies, plus the entity declaration to name the index to add.

## Decisions
| Question | Answer |
|---|---|
| Which statements | every distinct `statementFingerprint` the pass and test runs saw, whose first relation is an app entity. `x_*` tables are the framework's own unit (`db/src/statement-shape.ts`) |
| Which server | the gate's database. Both shipped engines are 16 or later, needed for `generic_plan`. A server below it: `X_QUERY_PLAN_UNAVAILABLE`, never a pass |
| Protocol | simple query: the extended one refused it in the probe (`08P01`, no parameters bound). `db/src/readonly-query.ts` stays the layer for agent SQL. Bun's driver path is unprobed: step 1 tests it |
| Red nodes | `Seq Scan` on an entity table; `Sort` under `Limit`; an `Index Scan` with no `Index Cond` |
| A plan it cannot build | generic planning can fail on an untyped parameter: recorded `unplannable`, listed and counted, not red. A growing count is visible in `--json` |
| Bounded table | `entity('plans', { scan: 'a closed catalog of 8 rows' })`, reason required. Reads as a decision in the diff |
| Hand-written statement that must scan | `expectedSeqScan('<reason>', fn)`, the shape of `expectedQueryLoop` (`db/src/expected-loop.ts:37`) |
| Row count effect | N+1 is decided by growth: the pass runs at 2 and 8 rows per parent; a shape whose count grows with rows is red, unless under `expectedQueryLoop` |
| Foreign key with no index | static, same step: a parent delete scans the child under lock. No exercise needed |

## Files to change
- `packages/testing/src/plan-oracle.ts` (new) — pure: plan JSON to verdicts. Fixtures from the probe.
- `packages/testing/src/plan-sweep.ts` (new) — settings, simple protocol, dedupe, column names from `Filter`/`Sort Key` mapped to properties.
- `packages/testing/src/scale-sweep.ts` (new) — two runs, per-shape growth, reads `fixture-statements.ts`'s shapes.
- `packages/testing/src/exercise.ts`, `exercise-report.ts` — statements kept; findings attached to the primitive that sent them.
- `packages/db/src/expected-loop.ts:37` — `expectedSeqScan` beside `expectedQueryLoop`; exported from `db/src/index.ts`.
- `packages/entity/src/entity.ts:53` — `scan?: string`; `describe.ts`; `manifest/src/build.ts`, `diff-entities.ts`.
- `packages/cli/src/exercise-static.ts` — the foreign-key half, under the `exercise` step. No flag turns the sweep off.
- `examples/dummy/packages/db/src/`, `dummy/social-media-clone/packages/db/src/` — the indexes it finds, `x db gen`; `scan:` on `plans`.
- `wiki/Entities-And-Migrations.md`, `wiki/Testing.md`, `wiki/Batching-And-Preloading.md`, `wiki/Error-Codes.md`, `packages/testing/{README,CLAUDE}.md`, `packages/db/{README,CLAUDE}.md`, `packages/entity/{README,CLAUDE}.md`.

## Steps
1. `plan-oracle` from the six probed plans plus `update`, `delete` and a join, on PGlite and on test-services Postgres 17 (`docker/docker-compose.test.yml:80`). Postgres 17 was not probed: a disagreement stops this slice for a design note.
2. Sweep on the migrated database, read-only: settings are `set local` in a transaction that rolls back.
3. Finding: primitive, statement fingerprint, node, and a fix pasted from the entity (`indexes: [{ on: ['orgId', 'authorId'] }]`), leading with the tenant column when the entity has one.
4. Scale sweep: same seed at two sizes; an honest `limit` keeps a read flat, and it is measured rather than assumed.
5. Run on both tracked apps; add the indexes; each `scan:` carries its reason. State the counts in the PR.

## Error codes
`bun run new-error-code <CODE> --package testing …` (tier 5, neither flag).
| Code | When | Fix |
|---|---|---|
| `X_QUERY_UNINDEXED` (new) | a seq scan, or an index scan with no condition | `indexes: [{ on: [<cols>] }]` on `entity('<t>')`, then `x db gen "index <t> <cols>"`; or `scan: '<why>'` |
| `X_QUERY_SORT_UNSERVED` (new) | a limited read sorts rows | the index above with the order's columns, in order |
| `X_QUERY_SCALES_WITH_ROWS` (new) | a shape's count grows with rows | `preload()`, or `expectedQueryLoop('<why>', fn)`; shape and primitive printed |
| `X_DB_FOREIGN_KEY_UNINDEXED` (new) | a reference column has no leading index | `indexes: [{ on: ['<col>'] }]`, then `x db gen` |
| `X_QUERY_PLAN_UNAVAILABLE` (new) | the server predates `generic_plan` | point the gate at the embedded database: unset `DATABASE_URL`, then `x verify --only exercise` |

## Tests
- `testing/src/plan-oracle.test.ts` (unit): each probed plan; a mutated verdict fails. `plan-sweep.live.test.ts`: both engines, empty tables; adding the index turns red to green.
- `testing/src/scale-sweep.test.ts`: a loop over rows is red; `preload` is flat; a loop under `expectedQueryLoop` passes with its reason reported.
- `cli/src/exercise-static.test.ts`: a reference with no index. `entity/src/entity.test.ts`: `scan: ''` refused.
- `bun test packages/testing/src/plan-oracle.test.ts`.

## Semver
Breaking: a new red verdict; the Upgrading entry is the printed list. Each finding is one `indexes:` line and a generated migration, built concurrently by [`04-db-migration-safety.md`](04-db-migration-safety.md), or a stated `scan:`.

## Done when
- Removing an index from `examples/dummy` turns `x verify` red on the primitive that needed it, on empty tables.
- A loop over rows in a handler is red with no test naming it.
- Both tracked apps green, each exemption with a reason. `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
