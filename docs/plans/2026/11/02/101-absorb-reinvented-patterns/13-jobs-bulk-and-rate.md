# 13 — Jobs: bulk enqueue, and the fleet rate budget that already exists

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-db-entity-cancellation.md) (`abandonment`). Tier: 3 (`jobs`), 2 (`entity`, fix text only).

## Why
**Bulk.** One adopter carries 32 files and a lint rule against enqueue-in-a-loop. Measured on Postgres 2026-11-02, 1,000 rows:

| Path | Time | Statements |
|---|---|---|
| `driver.enqueue` loop | 1,098 ms | 1,000 |
| outbox stage loop, one transaction | 629 ms, connection pinned throughout | 1,000 |
| one `jsonb_array_elements` insert | 18 ms | 1 |

The handle has only `enqueue` (`jobs/src/job.ts:212`). The strict fixture and `x dev` already flag the loop as `X_N_PLUS_ONE_WRITE`, and its `fix:` names `insertAll`, which no enqueuer can call.

**Rate.** Three adopters hand-rolled a fleet limiter (464 LOC in one). The mechanism is public and nobody can find it: `wiki/Jobs-And-Workflows.md:151` says no job rate limit exists and `wiki/Known-Gaps.md:114` defers it. Probe, public API only: a job body calling `rateLimiter(...).assert(key, bucket)` over the memory store settled `retried`, row `attempt: 0`, `runAt` in the future, by `jobs/src/retry-classification.ts:99`. The boot installs the shared store on every role (`cli/src/runtime-services.ts:394`).

## Decisions
| Question | Answer |
|---|---|
| New rate seam, `rate:` on `job()` | no. A second limiter beside `@ultimat3/http`'s. Docs and one use |
| Shipped guard for enqueue-in-a-loop | no. The N+1 detector is the build error, in the `statements` fixture. It gets the right fix, and a text scan would flag every loop with per-item `runAt` |
| Per-item options | none. One `options` for the batch, without `runId` (one id is one run). Per-item needs mean `enqueue` |
| Past a deadline | refused like `enqueue`: `abandonment()` checked once in the facade before either path, and before each chunk on the direct path, which no transaction guard sees. Staged chunks are held by the tx guard |
| Relay publishes | one by one here. The cost leaves the caller's transaction, which is the failure here. [`30-perf-jobs-claim-relay.md`](30-perf-jobs-claim-relay.md) batches it on this statement |
| Ids on the driver path | a request may carry its own `id` and `runId`, as a relayed row does: the facade's `enqueueMany` has no `runId` option, the driver's statement honours what a request states |
| Atomicity | one statement per chunk. Outside a transaction a failure past a chunk boundary leaves the earlier chunks enqueued; wrap the call in `withTransaction` for all-or-nothing, the `insertAll` rule |

## Files to change
- `packages/jobs/src/job.ts:212` — `enqueueMany(inputs: readonly I[], options?: EnqueueManyOptions): Promise<readonly EnqueueResult[]>`, answers in input order. `EnqueueManyOptions = Omit<EnqueueOptions, 'runId'>`.
- `packages/jobs/src/outbox.ts:210,277,319` — the facade's `enqueueMany`; `enqueueInTx`'s record building extracted so both share it; `OutboxStore.stageMany?(tx, records)`, optional; absent, the facade loops `stage`. The memory store implements it.
- `packages/jobs/src/outbox-pg.ts:107` + `driver-pg-outbox-sql.ts:10` — `SQL_OUTBOX_STAGE_MANY` over `jsonb_array_elements($1::jsonb)`, carrying the same `NOTIFY_STAGED` clause once.
- `packages/jobs/src/driver.ts:320` — `enqueueMany?(requests)` optional, like `introspect`. Absent: the facade loops `enqueue`.
- `packages/jobs/src/driver-pg.ts:265` + `driver-pg-sql.ts:61` — `SQL_ENQUEUE_MANY`, same conflict target as `SQL_ENQUEUE`, one notify per statement; takes each request's own `id` and `runId`, and carries `where not exists (select 1 from x_jobs published where published.id = …)`, or a repeated publish after a crash runs a finished job again. The rows it did not return are looked up by key and answered `deduped: true`.
- `packages/jobs/src/driver-memory.ts:233` — implements it; `driver-parity*.test.ts` holds it level. Redis stays on the loop: one script per operation, added when measured.
- `packages/jobs/src/errors.ts` — the size refusal.
- `packages/entity/src/n-plus-one.ts` — a `write` loop whose subject inserts into `x_outbox` or `x_jobs` names `handle.enqueueMany(inputs)`.
- `wiki/Jobs-And-Workflows.md:34,151` — the handle row; the rate row names the recipe in step 5. `wiki/Known-Gaps.md:114` — drop "named fleet-wide rate limiters"; `wiki/Error-Codes.md`; `packages/jobs/README.md`, `packages/jobs/CLAUDE.md` ("One enqueue implementation" gains it).
- `examples/dummy/apps/web/app/webhooks/service.ts:93` — the per-endpoint loop becomes `enqueueMany` (`send-digest.ts:100` stays: one enqueue per step on purpose); a `deliver-digest` send spends a declared vendor bucket for the recipe. Check `x.manifest.json` afterwards.

## Steps
1. `bun run new-error-code X_JOB_ENQUEUE_BATCH_TOO_LARGE --package jobs --title '…' --cause '…' --fix '…' --off-socket`. `MAX_ENQUEUE_BATCH = 10_000`, beside `MAX_JOB_PAGE`. Empty input answers `[]` with no statement.
2. Stage path: one statement per chunk of 1,000, on the caller's connection.
3. Direct path: same chunks, ids allocated here so the answer can be built without a read per row.
4. `idempotencyKeyFor` per input, first, so an empty key refuses before any write. Two inputs sharing a key in one batch: first inserts, second `deduped: true` (`on conflict do nothing` covers it inside one statement).
5. Recipe, documented in the wiki: `rateLimiter({ config, store: installedRateLimitStore() }).assert(key, bucket)` as the body's first line, ahead of the first `step.run`, so a refusal replays nothing. Refusal keeps the attempt.
6. N+1 fix text. Fingerprint read from `StatementLoop.subject`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_JOB_ENQUEUE_BATCH_TOO_LARGE` | `inputs.length > MAX_ENQUEUE_BATCH` | split the input, or enqueue one job per page that fans out: `backfill()` |
| `X_RATE_LIMITED` (existing) | the recipe's refusal | existing; deferred uncounted |

## Tests
- `packages/jobs/src/enqueue-many.test.ts` (memory) + `.live.test.ts` (Postgres, from the shared fixture): input order kept; dedup within the batch and against a live row; rollback stages nothing; 1,000 inputs = 1 statement, counted through the executor; a request's own `id` and `runId` land; the same `id` after its job finished adds no row.
- `packages/jobs/src/rate-recipe.job.test.ts`: two jobs, one-token bucket, public API only: second is `retried`, `attempt` unmoved, `maxAttempts: 1` not dead-lettered. Pins the seam the wiki names.
- `packages/jobs/src/enqueue-many.test.ts`: a store with no `stageMany` still stages all in order; an aborted coded signal refuses before any row on both paths and between direct chunks; inside `runToCompletion` it lands. An uncoded abort lands.
- `packages/entity/src/n-plus-one.test.ts` extended: subject `insert into x_outbox` gets the `enqueueMany` fix.
- `set -a; . docker/test-services.env; set +a; bun test packages/jobs packages/entity/src/n-plus-one.test.ts`

## Semver
**Breaking, one row.** The exported `JobHandle` gains a required member. `JobDriver.enqueueMany` and `OutboxStore.stageMany` stay optional, so an out-of-tree store or driver keeps working on the loop.
Upgrading: "A hand-written `JobHandle`, usually a test fake, adds `enqueueMany`." The refusal past a deadline arrives with [`02`](02-db-entity-cancellation.md)'s major.

## Done when
- 1,000 inputs in a transaction send 1 statement, under 50 ms on the test service.
- A job refused by the recipe keeps its attempt count, proved by the job suite.
- `Known-Gaps` and `Jobs-And-Workflows` no longer deny the rate budget.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
