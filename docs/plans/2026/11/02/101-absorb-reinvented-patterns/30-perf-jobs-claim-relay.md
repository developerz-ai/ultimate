# 30 — Perf: the claim seeks, the relay publishes in batches

> Part of [`overview.md`](overview.md). Depends on: [`13`](13-jobs-bulk-and-rate.md) for the relay half only. Tier: 3 (`jobs`).

## Why
**Claim.** A claim's cost grows with the backlog, so a queue slows down exactly when it is behind. `SQL_CLAIM` (`jobs/src/driver-pg-sql.ts:112`) ORs the `running` arm into the state test, so the partial `x_jobs_claim_idx` cannot serve the `order by`, and `queue = any($1)` would block an ordered scan anyway. Every claim reads and sorts every due row. The worker re-claims on each freed slot (`jobs/src/worker.ts:141`).

Measured 2026-11-02, Postgres 17 with fsync off, 1M `done` rows, shared box at load 5–60, so read ratios and not absolutes:

| Backlog 100k | Today | Rewritten statement |
|---|---|---|
| `EXPLAIN ANALYZE`, one queue (50k due) | 88–122 ms, Bitmap Heap Scan + Sort | 0.8 ms, Index Scan on `x_jobs_claim_idx` |
| Same, three queues (100k due) | 130–189 ms, external merge sort, 4.7 MB on disk | 0.7–0.9 ms |
| Real `jobWorker`, noop job, 8 slots | 42–55 jobs/s, claim 123–160 ms | 443–493 jobs/s, claim 4–6 ms |

At a backlog of 1,000 both drain the queue inside the window, claim 15 ms against 11 ms. Probe of the same scenarios on both statements printed identical results: cross-queue `run_at` order, a future row untouched, due `delayed` and `suspended` claimed, a paused queue skipped, a lapsed lease retried, a poison row buried and counted, and 8 sessions over 240 rows (each row once, 40 dead, none left).

**Relay.** `outboxRelay` costs two statements per row (`jobs/src/outbox-relay.ts:100`): 538–656 rows/s measured over 50k staged rows. One statement doing the same batch of 100 ran 8,896 rows/s. 13 lets a caller stage 10,000 rows in one statement, and those rows then take about 17 s to reach workers. 13 decided "relay publishes one by one, the cost leaves the caller's transaction"; true of the caller, and this half is the measured follow-up.

## Files to change
- `packages/jobs/src/driver-pg-sql.ts:112` — the `picked` CTE only; `buried`, `counted`, `claimed` untouched. Doc comment states why, with the table above.
- `packages/jobs/src/driver-pg-array.live.test.ts:65` — pins `any($1::text[])`; becomes `unnest($1::text[])`.
- `packages/jobs/src/outbox-relay.ts:100` — publish through `driver.enqueueMany` when present.
- `packages/jobs/src/outbox.ts:90` — `OutboxStore.markPublishedMany?(ids, at, claimant)`, optional like `release`.
- `packages/jobs/src/outbox-pg.ts:174` + `driver-pg-outbox-sql.ts` — `SQL_OUTBOX_MARK_PUBLISHED_MANY`, same two fences as `SQL_OUTBOX_MARK_PUBLISHED`, over `id = any($1::uuid[])`.
- `packages/jobs/CLAUDE.md`, `wiki/Jobs-And-Workflows.md` — relay row.
- `docs/idea/17-scale-ladder.md:203` — the `x_jobs_claim_idx` row names the seek.

## Steps
1. Claim first; it needs nothing from 13 and can land alone.
2. Rewrite `picked` in three parts: `open` is `unnest($1::text[])` minus paused queues (one `not exists` per queue, not per row); two `cross join lateral` arms per open queue, each `order by run_at limit $2 for update skip locked`; an outer `order by run_at limit $2` over their `union all`. The due arm is `state in ('ready','delayed','suspended')`, matching the index predicate word for word. The lapsed arm is `state = 'running' and visible_at <= now()`, served by `x_jobs_depth_idx`. `exhausted` is `false` in the due arm and `attempt >= max_attempts` in the lapsed one. No new index and no DDL.
3. Locks taken and not picked (at most `2 × limit × queues`) release at transaction end, not statement end. It is correct only because the claim autocommits: `exec()` at `driver-pg.ts:334` is the pool, so the two coincide. A concurrent claimer may skip them for one poll, which `skip locked` already permits. The doc comment says so; a claim inside a transaction would hold them for its life.
4. Relay, after 13, whose `SQL_ENQUEUE_MANY` already honours each request's `id` and `runId` and refuses a repeat: batch `enqueueMany`, then `markPublishedMany`. A batch failure drops to today's row loop for that batch, so stop-at-first-failure and `release` of the rest (`outbox-relay.ts:123`) keep their order guarantee and a poison row is still the row named in the log. Either optional method absent: today's loop.

## Error codes
None. A failed batch logs the existing `jobs.outbox.publish-failed` from the row loop it falls back to.

## Tests
- `driver-pg-claim.live.test.ts`: add a plan test over a 20k backlog, `explain` of `SQL_CLAIM` has `x_jobs_claim_idx` and no `Sort` under `LockRows`. Fails on today's statement.
- Same file: add the scenarios listed in *Why*, asserted on the new statement.
- `.job.test.ts` suites run the statement on the embedded database; not probed yet, so run them. `bun test packages/jobs/src/queue-wake.job.test.ts`.
- `outbox-relay` unit: a store and driver with the batch methods get one call per batch; a batch that throws falls back and publishes in order up to the failing row. A live repeat-publish test through the relay: same batch twice, terminal job between, no second row.
- `bun test packages/jobs` then `TEST_DATABASE_URL=… bun test packages/jobs/src/driver-pg-claim.live.test.ts`.

## Semver
Minor. No API or schema change for the claim. Two optional driver and store members for the relay.

## Done when
- At a 100k backlog, a noop `jobWorker` holds at least 5× today's jobs/s, and claim `EXPLAIN` is under 5 ms.
- `driver-parity*` and every jobs live and job suite green.
- A 10k staged batch publishes at 5,000 rows/s or better on the same box, measured and recorded in the relay's doc comment.
