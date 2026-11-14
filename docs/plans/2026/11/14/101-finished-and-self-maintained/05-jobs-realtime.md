# 05 — jobs and realtime

> Part of [`overview.md`](overview.md). Depends on: [`01`](01-production-hotfixes.md), [`02`](02-core.md). Tier: 3.

## Files to change
- `packages/jobs/src/` claim, counters, introspection — J1. Production: 182k sequential scans of `x_jobs` reading 4.55B tuples; the statement was evicted from `pg_stat_statements`, so the source is unknown.
- `packages/jobs/src/` DDL — J2. `x_jobs (created_at desc, id desc)`: 4.4 MB, 218 scans (carried: J2).
- `packages/jobs/src/` settle — J3. At-most-once settle (carried: J11, `wiki/Known-Gaps.md:53`).
- `packages/jobs/src/` scheduler state — J4. 8.8M sequential scans of a 43-row table; 25% dead tuples.
- `packages/jobs/src/` worker loop + `packages/cli/src/` role health route — J5. Worker, scheduler and replicator liveness reads `/metrics`; a wedged loop passes.
- `packages/jobs/src/limits.ts` — J6. Named limiters shared across jobs; two adopters built their own (225 LOC and a retry/pace set of ~1,060 LOC).
- `packages/jobs/src/inspect*.ts` — J7. Three `NotImplementedError` sites.
- `packages/realtime/src/` — R1. Multi-node realtime over the bus is unproven (`wiki/Known-Gaps.md:82`). R2: the production count owed from 2026/11/11 R10 step 4.

## Steps
1. J1: find it before fixing it. A live test runs every framework statement against a seeded `x_jobs` and fails on any plan with a sequential scan above a row floor (the `x explain` machinery). Fix what it names. Ask [`30`](30-infra.md) I3 for the job-state view so production can confirm.
2. J2: drop the index if the test in step 1 shows no reader; ship the drop as a framework migration.
3. J3: as designed in `docs/plans/2026/11/11/101-full-stack-efficiency-sweeps/09-jobs.md:105`.
4. J4: read scheduler state once per tick, not per schedule; set per-table autovacuum storage parameters for the small hot tables (`x_outbox`, `x_job_workers`, `x_scheduler_state`) in the framework DDL.
5. J5: each loop stamps a heartbeat; the role's liveness route answers 503 when the stamp is older than a declared multiple of the tick. [`09`](09-deploy-contract.md) points the probe at it.
6. J6: `limiter(name, { rate, concurrency })` declared once, referenced by any job; Postgres-backed so it holds across replicas. Priority stays "a separate queue" (settled 2026-11-11). Batches: a job that fans out and awaits its children already exists as steps — document it where the adopter looked; build nothing.
7. J7: implement or remove each inspect stub with its port row.
8. R1: a live suite with two realtime nodes on the bus: publish on one, deliver on the other, ordering and gap detection across a node restart. Passing closes the Known-Gaps row; failing is a defect to fix here, not a row to keep.

## Tests
- `bun test ./packages/jobs/src/statement-plans.live.test.ts` — fails on a sequential scan.
- `bun test ./packages/jobs/src/limiter.live.test.ts` — two workers never exceed the declared rate.
- `bun test ./packages/jobs/src/heartbeat.test.ts` — a blocked loop turns liveness 503 within the bound.
- `bun test ./packages/realtime/src/multi-node.live.test.ts` (export `TEST_NATS_URL` when the default port is taken).
- `concurrency-auditor` on the sweep diff.

## Done when
- Adopter E's `x_jobs` shows no growth in sequential scans over 7 days on the release.
- Zero `NotImplementedError` in `packages/jobs/src`; the multi-node row is gone from `wiki/Known-Gaps.md`.
