# 09 — jobs: an idle queue that costs nothing, and the three mechanisms apps keep rebuilding

> Part of [`overview.md`](overview.md). Depends on: [`03`](03-db.md) (prepared pool, D3) for J9 only; [`02`](02-schema-core.md) for nothing. Tier: 3. Two sweeps: 9a idle and lifecycle cost (J1–J10), 9b mechanisms (J11–J17).

Production, a near-idle deployed app, 26.4 h (2026-11-10 → 11): 183,019 statements in the database, most of them the framework polling; ~72% of 95 MB of WAL from job, heartbeat, counter and rate-limit statements; the claim spent 34.4 s planning for 3.9 s executing. Each fix names the correctness property the poll or write protects and keeps it.

## 9a — idle and lifecycle cost

| ID | Sev | Status | Where | Finding | Fix (property kept) |
|---|---|---|---|---|---|
| J1 | P1 | confirmed | `packages/jobs/src/driver-pg-sql.ts:110-116` (`SQL_HEARTBEAT`); `driver-pg-ddl.ts:234-236,242` | One job = insert + claim update + a lease renewal every 10 s + ack. The renewal sets `updated_at`, which two indexes cover, so every heartbeat is a non-HOT update writing every matching index. Lifetime in production: 247,180 updates, 8 HOT | drop `updated_at = now()` from the heartbeat and from progress (`driver-pg-operator-sql.ts:130`): nothing reads it on a `running` row, retention reads it for terminal states only. `alter table x_jobs set (fillfactor = 80)`. Claim and ack change `state` and stay non-HOT |
| J2 | P1 | confirmed | `driver-pg-ddl.ts:234-236` vs `:242`, `:230`; `jobs-retention.ts:44-63` | `x_jobs_finished_idx` covers `done`, and `x_jobs_done_idx` covers `done` again; retention reads `done` through the second alone. `x_jobs_created_idx (created_at desc, id desc)` (4.4 MB, 206 scans) duplicates the primary key's order: ids are UUIDv7 | narrow `finished_idx` to `('failed','dead','cancelled')` under a new name, drop the old; drop `created_idx`, operator listings page by `id desc`. Boot DDL as `create/drop index concurrently`, statement by statement (as `dev-queue.ts` applies) |
| J3 | P2 | confirmed | `driver-pg-settle-sql.ts:28-34`; `driver-pg-operator-sql.ts:217-236`; `scheduler.ts:56,259-261` | Every settle upserts its `(job, minute)` counter row; the 10-minute fold deletes and re-inserts every bucket (the largest framework WAL writer: 16 MB/day at idle) | per-process `Map<(job, bucket), deltas>` flushed every 10 s and on drain in one multi-row upsert; the counter CTE leaves `SQL_ACK`/`SQL_NACK`; the fold skips when no bucket is old enough. A crash loses ≤ 10 s of *counts*; the row's `state` stays the truth — say so in `introspection.ts` |
| J4 | P2 | confirmed | `idle-backoff.ts:14,21`; `worker-loop.ts:80`; `driver-pg-claim-sql.ts:54`; `driver-pg-operator-sql.ts:140` | With the `LISTEN` wake proven, an idle worker still claims every ≤ 5 s (28,294 claims, 87% empty). The poll protects: a lost `NOTIFY`; rows due by the clock; a crashed worker's lapsed lease; a queue resumed by `SQL_RESUME`, which sends no `pg_notify` | an empty claim also returns the next due instant (`min(run_at)` over ready/delayed/suspended via `x_jobs_claim_idx`, `min(visible_at)` over running via `x_jobs_depth_idx`); sleep until `min(nextDue, 60 s)` while `wakeIsLive()`, today's ceiling otherwise. `pg_notify` added to resume and pause. `DUE_HINT_MAX_MS` already exists in `worker-loop.ts`: feed it |
| J5 | P2 | confirmed | `outbox-relay.ts:120-124`; `driver-pg-outbox-sql.ts:71-89` | The outbox claim runs every 5 s on an outbox that has had 6 rows in its life (18,974 calls, 0 rows). Protects: a lost `NOTIFY_STAGED`; rows a dead relay claimed | same design: an empty claim returns `min(claimed_at) + lease` of claimed unpublished rows; sleep until `min(that, 60 s)` while the wake is live |
| J6 | P3 | confirmed | `driver-pg-operator-sql.ts:155-170`; `worker-registry.ts:96`; `worker-options.ts:57` | Every 10 s a worker rewrites its whole registry row (`queues`, `in_flight` jsonb) whether or not anything changed | full row only when `in_flight`, `draining` or `build` changed; else a narrow `set heartbeat_at, expires_at`. Registry TTL 60 s, renew every 20 s, decoupled from the lease heartbeat. Protects: expiry of a killed worker, `SQL_SCALER_DEMAND`, `x deploy verify` — recheck each with the new TTL |
| J7 | P3 | confirmed | `steps.ts:168`; `driver-pg-sql.ts:380` | One extra round trip per run to list its steps, even on a first attempt (7,115 calls) | the claim returns each row's steps (`left join lateral … json_agg` on the primary key); `ClaimedJob.steps?`; memory and Lua mirror. Step *writes* stay one insert each: that is the durability contract |
| J8 | P3 | confirmed | `jobs-retention.ts:114-128` | The orphan step sweep filters `started_at < cutoff` with no index: a full scan of `x_job_steps` per pass (66,769 rows, growing) | run the orphan pass at most once a day (cadence in `purge.ts`): it protects only "the sweep died between a batch and its follow-up". BRIN is decided out for declared indexes (`packages/db/src/index-method.ts:8-20`); a btree on an append-only table would tax every step write for a daily read |
| J9 | P2 | plausible (feasibility in [`03`](03-db.md) D3) | `driver-pg-claim-sql.ts:55`; `packages/db/src/bun-sql.ts:101-107` | `prepare: false` re-plans the claim on every call: plan time 8.8× execution | first try the cheap route: simplify the claim's plan (the `unnest` × `lateral` shape) and measure `total_plan_time`. Only if that fails, move claim, heartbeat and outbox claim to [`03`](03-db.md)'s framework prepared pool, with explicit column lists |
| J10 | P3 | confirmed | `scheduler.ts:191`; `scheduler-pg.ts:105-145` | `jobs.scheduler.dispatched` at `info` per fire is 88% of a scheduler pod's lines; sibling per-unit events are `debug`. Leader lease renewed every 10 s | `debug` for an on-time fire, `info` kept for `catchUp` and `already-fired` (`:179`). `DEFAULT_LEADER_TTL_MS` 60 s, renew every 20 s. No advisory-lock rewrite: not worth a second wire path |

## 9b — mechanisms

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| J11 | P2 | confirmed (`wiki/Known-Gaps.md:53`); 4 adopters built heartbeat + lease + stale-sweep | `execute.ts:459-477`; `settled.ts:7-9`; `driver-pg-settle-sql.ts:22` | `onSettled` is at-most-once across a crash: the ack lands, then the hook runs in the same process | `x_jobs.settle_owed boolean` + partial index; `SQL_ACK` and the failing `SQL_NACK` set it when the handle declares `onSettled`; a fenced clear after the hook returns; the scheduler leader's tick claims `settle_owed and updated_at < now() - onSettledTimeout × 3` (`skip locked limit 50`) and re-drives with `redriven: true, reason: 'lost'` (`result` undefined: `JobCompleted.redriven`). Memory and Lua mirror |
| J12 | P2 | confirmed | `worker-run.ts:161`; `heartbeat.ts:36-37,59`; `job-types.ts:19-49` | Lease renewal is automatic, but the body has no handle: a long synchronous section starves the timer, an external hand-off cannot say "alive" | `args.lease: { renew(): Promise<boolean>; lost(): boolean; readonly signal: AbortSignal }`, three lines over `LeaseHeartbeat`. `wiki/Jobs.md` names `withLock()` for a lease that outlives one job |
| J13 | P2 | confirmed absent (`wiki/Known-Gaps.md`: deferred); ~75 hand-written pairs across 4 adopters | `packages/core/src/registrar.ts:71` (`PRIMITIVE_FACTORIES`); pattern `packages/jobs/src/partitions.ts:112` | No one-declaration task + its job | `cronJob({ name, cron, tz, input?, catchUp?, …jobDefinition })` → the job handle with `.schedule: TaskHandle` (`<name>.schedule`). A factory over `job()` + `task()`: one `PRIMITIVE_FACTORIES` row, no ninth primitive. `tz` required (no ambient zone). `x g cron-job` in [`14`](14-cli-commands-upgrade.md) |
| J14 | P3 | confirmed absent; 1 adopter report | `outbox.ts:235-251`; `job-types.ts:57-121` | No debounce, no expiry | debounce: `onConflict: 'replace'` updates `input` and `run_at` of a `ready`/`delayed` row under the same key, one statement per driver. Expiry: `expiresAt` on enqueue; the claim settles a lapsed row `failed` with reason `expired`. No batch callback: `step.run` fan-out covers it |
| J15 | P3 | confirmed absent | `driver-pg-claim-sql.ts:64-91` | No priority inside a queue (claim orders by `run_at`) | owner decision OD2 in [`90`](90-owner-decisions.md). Default if unanswered: document "priority = a separate queue" in `wiki/Jobs.md` and close the row; a `priority` column costs a wider claim index on the hottest table |
| J16 | P3 | confirmed | `driver-redis.ts:169-170` | `EVAL` ships the full script (claim: 2,582 B) on every operation | `SCRIPT LOAD` once, `EVALSHA`, `NOSCRIPT` → `EVAL` fallback |
| J18 | P3 | confirmed | `steps-output.ts:90-121` (no size check); `steps.ts:163-171` (hydration lists every record) | A step's output has no byte ceiling, and every attempt loads every output of the run: 1,000 steps × 1 MB is ~1 GB per attempt, again on every retry | a per-step ceiling (256 KiB, `stepOutputMax` on the job), refused at step completion with a new coded error whose fix says to persist a key or cursor and keep the payload in storage, as `export`/`backfill` do |
| J19 | P3 | absent (catalogue) | enqueue path | A producer cannot be refused when a queue is drowning | optional `job({ maxPending })`: an enqueue past it is `X_JOB_BACKLOG_FULL` (429-mapped); a conformance row |
| J17 | P3 | confirmed | 77 pinned real-clock waits in `packages/jobs/src/*.test.ts` (`scripts/lib/test-real-sleep-pins.ts`) | negative claims ("not wedged") raced against `Bun.sleep(200–600)` | fixed in [`17`](17-test-determinism.md); listed here so the jobs workers leave those files to that slice |

## Files to change
- 9a: `packages/jobs/src/driver-pg-sql.ts`, `driver-pg-ddl.ts`, `driver-pg-claim-sql.ts`, `driver-pg-settle-sql.ts`, `driver-pg-operator-sql.ts`, `driver-pg-outbox-sql.ts`, `driver-pg.ts`, `driver.ts`, `driver-memory.ts`, `driver-redis-scripts.ts`, `counter-batch.ts` (new), `counters.ts`, `idle-backoff.ts`, `worker-loop.ts`, `worker-run.ts`, `worker-registry.ts`, `worker-options.ts`, `outbox-pg.ts`, `outbox-relay.ts`, `steps.ts`, `jobs-retention.ts`, `scheduler.ts`, `scheduler-pg.ts`, `introspection.ts`.
- 9b: `execute.ts`, `execute-ctx.ts`, `settled.ts`, `job-types.ts`, `cron-job.ts` (new), `outbox.ts`, `driver-redis.ts`, `steps-output.ts`, `errors-steps.ts`, `index.ts`; `packages/core/src/registrar.ts` (the factory row); `packages/testing/src/job-driver-conformance*.ts`.
- `wiki/Jobs.md`, `wiki/Known-Gaps.md` (close three rows), `packages/jobs/README.md`, `CLAUDE.md`.
- Coordinator only: changelog + `wiki/Upgrading.md` (J2 drops indexes at boot; J3 changes counter freshness; J10 log level), `bun run manifest`.

## Steps
1. Before 9a: the infrastructure slice takes the dated statement and table snapshot ([`30`](30-infra.md) I2). Without it the after-number has no before.
2. 9a, three workers: W1 DDL + heartbeat + index diet (J1, J2, J8); W2 claim path (J4, J5, J7, J9) — one worker, it is one SQL file family; W3 counters + registry + scheduler (J3, J6, J10). Every driver change lands in memory, Postgres and Lua together with a parity fixture.
3. J4 is the risky one. Write the four property tests first (lost notify, clock-due row, lapsed lease, resumed queue), each red against a naive "sleep 60 s".
4. 9b, three workers: W1 J11; W2 J12 + J14 + J16; W3 J13 + docs.
5. After release and one day in production: re-run the probe; record calls/hour and WAL share of framework statements in this file's Outcome.

## Tests
- `packages/jobs/src/driver-pg-heartbeat.job.test.ts` — 100 heartbeats on one row raise `n_tup_hot_upd` by ~100.
- `packages/jobs/src/driver-pg-ddl.job.test.ts` — `EXPLAIN`: retention's ended branch uses the narrowed index; listing uses `x_jobs_pkey`; the orphan pass runs once per day of fake clock.
- `packages/jobs/src/worker-idle.test.ts` (fake clock) — idle worker + one delayed row: exactly 2 claims; a resume wakes it within one tick; a wake that is not live falls back to the short ceiling.
- `packages/jobs/src/counter-batch.test.ts` — 50 acks + one flush: one counter row update, sums equal.
- `packages/jobs/src/outbox-relay.test.ts` — empty outbox, wake live: ≤ 1 claim per 60 s; a staged row publishes at once.
- Parity fixtures: settle re-drive (kill between ack and hook → hook once with `redriven: true`; second reaper pass nothing); `args.lease.renew()` in a 2× visibility synchronous loop is not re-claimed; debounce; expiry; steps arrive with the claim.
- `packages/jobs/src/steps-output.test.ts` — a 300 KiB output refused with the code; 200 KiB passes.
- `packages/jobs/src/cron-job.test.ts` — one declaration registers both; `defineApi({ jobs })` picks up the task.
- Commands: `bun test ./packages/jobs/src/<file>.test.ts`; `.job.test.ts` needs `docker/test-services.env`.

## Done when
- An idle worker + relay + scheduler issue under 150 statements an hour against Postgres (measured locally with `pg_stat_statements`; production was ~2,700).
- HOT ratio on `x_jobs` above 0.5 under a heartbeat-heavy fixture.
- `wiki/Known-Gaps.md` rows for `onSettled`, the companion job and debounce/expiry closed.
- All three drivers pass conformance.

## Outcome (9a, local)

Ships as 31.13.0. `As of 2026-11-12`, measured before release; step 5's production probe (calls/hour, WAL share) is still owed.

| ID | Outcome |
|---|---|
| J1 | shipped. `SQL_HEARTBEAT` and `SQL_JOB_PROGRESS` write no `updated_at`; `x_jobs` at `fillfactor = 80` (`JOBS_TABLE_STORAGE`, in the framework schema's storage rows, so drift reports a hand reset). `driver-pg-heartbeat.job.test.ts`: > 0.9 of renewals HOT over packed pages |
| J2 | partial. `x_jobs_finished_idx` → `x_jobs_ended_idx` (`failed`, `dead`, `cancelled`). `x_jobs_created_idx` KEPT: `notifyJobReady` (`driver-pg-wake-sql.ts`) reads it on every immediate enqueue; dropping it waits on a wake rewrite over the UUIDv7 primary key (later sweep). Built NOT `concurrently`: the framework schema applies in one transaction (Postgres 25001); a non-transactional phase is sweep 16's |
| J3 | shipped, Postgres driver. `counter-batch.ts`, `SQL_COUNTER_FLUSH` every 10 s and on `close()`; reads flush their own process first; fold every 10 min, hourly after one that moved nothing. Memory counts in process; Redis keeps no counters |
| J4 | shipped; its one regression fixed in review (below). `SQL_CLAIM_IDLE` + `ClaimOptions.onEmpty`; `restAfter` rests ≤ `IDLE_REST_MAX_MS` (60 s) in 2 s slices. `pg_notify` on resume was already there (`driver-pg-operator.ts`, `wake`); pause needs none |
| J5 | shipped. `SQL_OUTBOX_CLAIM_IDLE`, `OutboxStore.claim(limit, { onEmpty })`; conformance in `outbox-store-conformance-horizon.ts` |
| J6 | shipped. `WORKER_REGISTRY_TTL_MS` 60 s (or the visibility timeout when longer), renewed every 20 s, `SQL_WORKER_RENEW` unless held ids or drain moved. Demand recheck found a defect and fixed it: a draining worker's job is counted again once its lease lapses |
| J7 | shipped. `ClaimedJob.steps` in all three drivers; parity in `job-driver-checks-claim.ts` |
| J8 | shipped. `upkeepCadence` (`PURGE_UPKEEP_EVERY_MS`, a day), per process |
| J9 | cheap route only: burial and claim in one update. Reported by the sweep's EXPLAIN probe (60 runs, 200,000 `done` rows, not re-derived here): planning per idle hour 612 → 85 ms — fewer claims, each planned slightly longer for the horizon arm. The prepared pool (D3) is not used |
| J10 | shipped. On-time `jobs.scheduler.dispatched` at `debug`; `DEFAULT_LEADER_TTL_MS` 60 s, renewed every 20 s |

An idle hour of one worker on two queues + an outbox relay + a scheduler leader with three daily tasks, the `LISTEN` wake live, on the embedded Postgres under fake timers, every statement counted at the executor. The probe is not committed (it lived in the sweep's scratch space); re-run against both trees for this table:

| Statement | 31.12.0 sources | 31.13.0 |
|---|---|---|
| worker claim (`SQL_CLAIM` → `SQL_CLAIM_IDLE`) | 720 | 60 |
| worker depth read (`SQL_STATS`) | 240 | 60 |
| worker registry (`SQL_WORKER_ANNOUNCE` → `SQL_WORKER_RENEW`) | 360 | 180 |
| relay claim | 720 | 60 |
| scheduler leader lease | 360 | 180 |
| counter fold | 18 | 3 |
| **total** | **2,418** | **543** |

The "under 150 an hour" done-when is not reachable at the decided cadences: the leader and registry renewals alone are 360 an hour (TTL 60 s, renewed every 20 s, so two renewals may fail before a row lapses). The depth read stays once per rest: it is the only publisher of `queue_depth` for a queue no running pod serves (scale from zero).

**Regression, fixed in review.** A job due more than 1 s out that ANOTHER process queued while a worker rested sent no notification, so it started when the rest ended — up to 60 s past its `runAt`. Now `WAKE_DUE_WITHIN_MS` = `IDLE_REST_MAX_MS` (60 s): such an enqueue notifies, slot-throttled as before, and the woken worker re-reads its horizon (`worker-rest-wake.job.test.ts`, on Postgres, no in-process signal). A retry or `step.sleep` handed back by a worker that then stops is announced by it (`JobDriver.wake`); a woken loop's first empty pass keeps the floor, so the slot-silent row is found a floor later (`idle-wake-slot.test.ts`); a driver without `wake` (Redis) never rests. The idle hour stays 543 statements (`idle-hour.job.test.ts`).

## Outcome (9b, local)

Ships as 31.14.0. `As of 2026-11-12`, before release. Conformance run locally on all three drivers: `job-driver-conformance.test.ts` (memory, 18), `job-driver-conformance.live.test.ts` + `outbox-store-conformance-postgres.live.test.ts` + `driver-pg-wake.live.test.ts` (Postgres, 27 together), `job-driver-conformance-redis.live.test.ts` (Redis, 15) — all green.

| ID | Outcome |
|---|---|
| J11 | **partial.** `x_jobs.settle_owed` + `x_jobs_settle_owed_idx` (partial, `updated_at`); an ending settle of a hooked job records the debt in its own write, the hook's return clears it under the claim, the scheduler leader re-drives debts older than `onSettledTimeout` × 3 (`settle-redrive.ts`, ≤ 50 a pass, 60 s after a find, 5 min after none) with `redriven: true, reason: 'lost'`. Memory, Postgres and Lua. **Still at most once:** a completion whose body returned a value — `x_jobs` stores no result, and a re-drive handing `result: undefined` to a hook typed for a value would break it on a minor; storing the result is `next`'s. And a row the CLAIM settles (final-attempt lease-lapse burial, expiry): the claim does not know which jobs declare a hook and records no debt (`claim-exhausted.ts`). `wiki/Known-Gaps.md` row narrowed to those two, pinned by `settle-redrive.test.ts` |
| J12 | shipped. `run({ lease })`: `renew()`, `lost()`, `signal` over the attempt's `LeaseHeartbeat` (`job-lease.ts`); `withLock()` named for a lease that outlives one job |
| J13 | shipped. `cronJob()` (`cron-job.ts`), one `PRIMITIVE_FACTORIES` row; the reference app's `sendDigest` is one and `nightly-digest.ts` is gone. Found on the way: `x verify` recognised a `partitions()` maintainer by its `<name>.schedule` shape, which a `cronJob()` shares, so one silenced `X_PARTITIONS_UNMAINTAINED`; now by identity (`isPartitionsJob`). `x g cron-job` is still [`14`](14-cli-commands-upgrade.md)'s |
| J14 | shipped. `onConflict: 'replace'` (`SQL_ENQUEUE_REPLACE`; a running or suspended holder untouched; the holder keeps its first `expiresAt`) and `expiresAt` (`JOB_EXPIRED`, settled by the claim, lazy), in all three drivers — and inside a transaction: `x_outbox.on_conflict` / `x_outbox.expires_at`, published alone by the relay. Neither is an `enqueueMany` option |
| J15 | documented, no code: priority is a separate queue (`wiki/Jobs-And-Workflows.md`, the `priority` row) |
| J16 | shipped. `EVALSHA` with an `EVAL` fallback on `NOSCRIPT` (`driver-redis-eval.ts`) |
| J17 | not here: [`17`](17-test-determinism.md)'s |
| J18 | shipped as a ceiling with a soft default. Declared `job({ stepOutputMax })`: `X_STEP_OUTPUT_TOO_LARGE`, terminal, nothing stored. Undeclared, past `STEP_OUTPUT_MAX_BYTES` (256 KiB): stored and logged once per job and step — refusing by default would fail shipped jobs on a minor, so that waits on `next` (`wiki/Known-Gaps.md` row, pinned by `steps-output.test.ts`) |
| J19 | shipped. `job({ maxPending })` → `X_JOB_BACKLOG_FULL` (429), one capped count (`JobDriver.backlog`, `SQL_BACKLOG`) before the write, on both paths; best effort under concurrent producers, which can overshoot by their number |

Also fixed: a job a `postgresJobDriver` enqueues inside a transaction open longer than one 250 ms wake slot notifies at commit (the wake reads `clock_timestamp()`); it waited for the worker's next pass, up to 60 s (`driver-pg-wake.live.test.ts`). Still silent: a transaction that enqueues in its first slot and commits after the woken worker's next pass.

Done-when, for 9b: the `onSettled` Known-Gaps row is narrowed, not closed (J11); the companion-job and debounce/expiry rows are closed; all three drivers pass conformance.
