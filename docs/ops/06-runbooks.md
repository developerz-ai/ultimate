# Runbooks

Every entry here exists because it happened to an operator running this stack in production
(`As of 2026-08`). Generalised: no cluster-specific names, no assumption you use the same tools.

## Which levers actually stick

Read this table **before** you touch anything in a GitOps cluster. Most live edits are reverted by a
parent controller within minutes, and you will spend the outage arguing with a reconciler.

| You edit, live | Reverted by | Sticks? |
|---|---|---|
| the image reference on a child app object | the parent app-of-apps | **yes**, but only if the parent ignores that path *and* respects its own ignore rules |
| an **annotation** on a child app object | the parent's self-heal, ~3 min | **no** — pausing must be done in git |
| `kubectl scale` on a controller the GitOps tool manages | that controller's own app self-heal | **no** |
| the apex app-of-apps itself | nothing — it has no parent | **yes** — this is the global break-glass |

A corollary worth internalising: **plain `ignoreDifferences` is display-only.** Without
`RespectIgnoreDifferences=true` in the sync options, self-heal still reverts the field you thought
you had excluded.

## Roll back a bad image

**Pause the image watcher first. This is not optional.** A controller tracking a moving tag
re-resolves it every poll (~2 min) and re-applies the newest digest, overriding your rollback. Set an
old digest while it is still watching and the bad one is back before you have finished verifying.

| # | Step |
|---|---|
| 1 | Find the known-good digest: the app object's sync history, cross-checked against the watcher's own log lines, authoritatively against the registry's per-commit tag |
| 2 | **Pause in git** — comment out the watch annotation, open a PR, merge. A live `kubectl annotate` does not hold |
| 3 | Set the known-good digest on the live app object. Multi-image apps need *every* entry in the array, not just the broken one |
| 4 | Force a refresh, then verify: sync status, health status, and the pods' actual image references |
| 5 | Smoke-test through the ingress against a real route. A healthy status is reachability, not correctness |
| 6 | **Fix forward.** Push a corrected image so the moving tag points at a good digest, *then* un-pause. Un-pausing while the tag still points at the bad image re-applies it within minutes |

While the pause PR is in review, step 3 is a valid holding action — re-run it each poll until the
pause merges.

**Global break-glass**, in this order: suspend the apex app (no parent, so it holds) → suspend the
watcher's own app (now the apex will not restore it) → scale the watcher to zero. Resume in reverse.

## An app is stuck and nobody noticed

The nastiest deploy failure: every controller healthy, every build green, and one app silently
serving weeks-old code.

| Symptom | Cause |
|---|---|
| App sits `OutOfSync` but reports `Healthy` | often benign server-side diffs — this is why "alert on OutOfSync" alone gets muted on day one and then covers nothing |
| App is `OutOfSync` **and not** `Healthy`, with auto-sync on | a sync-wave hook failed. A failed pre-sync Job blocks **every later wave**, so Deployments are never applied at all |
| App is `Unknown` | the tool cannot even compare desired against live — repo unreachable, or the manifests fail to render |

Do this:

1. Read the app's last operation message. A failed migration Job is the most common cause, and it
   names itself.
2. Fix the cause, not the symptom. Deleting the failed Job re-runs it and it fails again.
3. Alert on it so next time is minutes, not weeks:
   `max by (name, namespace) (app_info{sync_status=~"OutOfSync|Unknown", health_status!="Healthy", autosync="true"}) == 1` for 30m.
   The `health_status != "Healthy"` clause is load-bearing, and the `max by` aggregation is what
   stops label churn from resetting the `for` clock — see [`03-observability.md`](./03-observability.md).

## `ImagePullBackOff`

Usually terminal, occasionally not.

| Cause | Self-heals? |
|---|---|
| A digest that no longer exists — pruned, or never pushed | no |
| A dead or missing pull secret | no |
| Cold-start race: pods scheduled before the namespace's pull secret was unsealed | yes, ~1 min |
| Registry 5xx or rate limit | yes, minutes |

So alert with grace, not on the first sample: `max_over_time(...[5m]) == 1` for `10m`, which is
about five minutes of *sustained* failure. Do not drop the smoothing — each kubelet retry cycles the
waiting reason through `ContainerCreating`, both matched series vanish, and a raw expression resets
its clock on every retry and therefore never fires.

Check, in order: does the pinned digest still exist in the registry; is the namespace's pull secret
valid *and sealed for this namespace*; is the registry up.

## Deploys went quiet

With in-cluster image promotion there is **no git artifact** when it stalls — nothing to notice. Two
safety nets, neither of which needs a new scrape target:

| Alert | Expression |
|---|---|
| The image watcher is down | `kube_deployment_status_replicas_available{deployment="<watcher>"} == 0 or absent(...)`, for 15m |
| The GitOps controller is down | `up{job="<gitops-metrics>"} == 0`, for 10m — it is what turns a patch into an actual rollout |

Deliberately pausing the watcher by scaling it to zero trips the first one. Silence it for the
window, or pause per-app instead so the controller keeps running.

## Registry pruning ate the rollback target

Retention policy that works: protect the floating aliases by name (`latest`, `main`, `stable`,
`prod`), keep the newest N build tags by timestamp, delete the rest. Prune per-deploy, with a
scheduled sweep as the backstop for repos that have not adopted the per-deploy hook.

**Your effective rollback window is exactly `N`.** With `keep 2` you can roll back two deploys, worst
case. Rolling back is digest-based and does not need the *tag* to still exist — but it does need the
*manifest*, and garbage collection reclaims it minutes after the tag goes.

There is **no API to undelete a tag** in any major registry. Recovery is re-pushing from CI, which
produces a new digest with no continuity to the old one. If a bad push just landed and you suspect
another deploy is imminent, **pause the watcher before you do anything else**.

## Nobody was paged

Work outward from the alert:

| Check | How |
|---|---|
| Did the rule fire? | the alerting UI — if not, the expression is wrong or the metric name never existed |
| Did it route? | one unresolvable secret reference drops the **whole** routing-config object, leaving only the null receiver |
| Was it suppressed? | list alerts with `state=suppressed` and read `inhibitedBy`. An inhibition source that cannot self-clear is a permanent cluster-wide mute |
| Did delivery fail? | `alertmanager_notifications_failed_total` — and check that *this* alert routes over a path independent of the thing that is broken |
| Was the whole cluster down? | nothing in-cluster can page. This is what the off-cluster dead-man exists for |

Then fix the class, not the instance. Each row above corresponds to a countermeasure in
[`03-observability.md`](./03-observability.md).

## A migration failed mid-deploy

| Situation | Do |
|---|---|
| The migrate Job failed, no serving pod started | the old version is still serving. Fix the migration and re-deploy. **Do not** roll the image back past the migration — the schema may already be partly applied |
| The migration succeeded, the new code is broken | roll the image back. This is safe **only** if the migration was additive. If it dropped or renamed anything, the old code cannot run against the new schema, and the rollback is a second outage. Over additive rows the older image's pre-upgrade migrate Job **passes**: ledger rows newer than every migration that build ships are read as a rollback — nothing is applied or reverted, and the Job logs `ultimate migrate ledger ahead of build` naming each id (`ahead` in `x db migrate --json`). Redeploying the newer build later finds its migrations already applied |
| The migrate Job of a rollback exits `X_MIGRATION_ROLLBACK_DESTRUCTIVE` | the ledger records (`x_migrations.destructive`, written at apply) that a migration ahead of this build destroyed data — a dropped column or table this build may still read. Nothing was applied and nothing serves. Roll **forward** (`x deploy --image <the newer image> --json`); or, after checking this build runs on the newer schema, set `ROLLBACK_ALLOW_DESTRUCTIVE=<id>[,<id>…]` on the migrate role naming every refused row — the fix prints the list — and re-run. A row with no bit (`null`, applied before the ledger kept one) still only warns |
| The rollback over a dropped column was NOT refused | the refusing code must be in the image rolled BACK to. The ledger bit and the check ship in the same release (`As of 2026-11`, plan 101): a rollback to a build from before it, or over rows applied before it, cannot refuse. The guarantee starts with the release after this one; until then the row above this one is the rule |
| The migrate Job of a rollback exits `X_MIGRATION_CONFLICT` | the ledger is not a rollback: an unknown row sorts **between** migrations the older build ships (a deleted or renamed migration), or that build still has a migration it never applied here. The cause names the row and the version that applied it; deploy that version, or follow the `fix:` |
| The migration waits on a table lock | it does not wait forever: the `migrate` pool sets `lock_timeout` 3 s (`packages/db/src/pool-profile.ts`), so a DDL statement blocked by a long transaction fails with SQLSTATE `55P03`, and `migrate()` sends it again up to 5 more times, at least one timeout apart with a warn line each, before it exits `X_DB_LOCK_TIMEOUT` stating the attempts. Run `x db diagnostics --json` against the same database: `data.blockers.rows[]` names each waiting `pid` and the `blockedBy` pid holding it, with `blockerState` and `blockerTransactionSeconds`. End it (`select pg_terminate_backend(<blockedBy>)`) or wait for it, and re-run the release. The statement itself still has no timeout, by design — a long backfill-free migration is allowed to run |
| `X_MIGRATE_CONCURRENT` | another migrator held the migration's advisory lock for the whole 60 s bounded wait (`MIGRATION_LOCK_WAIT_MS`). Two overlapping deploys serialise while the first is merely slow; this code means the first did not finish. Check for a stuck migrate Job (`kubectl get jobs`), let it finish or delete it, then re-run |
| The migrate Job exits non-zero after applying, with `X_DB_DRIFT` | every migration applied, and the live schema does not match what the ledger says it should — a hand-made change, or a migration written outside `x db gen`. `ROLE=migrate` refuses (`assertNoSchemaDrift`) so the deploy does not roll on. Run `x db migrate --json` against the same database for every difference, reconcile, re-deploy |

The rule that prevents the second row is in [`01-kubernetes.md`](./01-kubernetes.md): **expand in one
release, contract in the next.** It is `X_MIGRATION_ROLLING_UNSAFE`, not a runbook step, because by
the time you are reading a runbook it is already too late.

**`helm rollback` runs these checks only onto a revision a 31.29+ chart rendered** (its Job is a
`pre-rollback` hook, and Helm runs the target revision's hooks); onto an older one it skips them, so
roll back with `x deploy --image <previous> --json` ([deploy contract](./07-deploy-contract.md#rollback),
[`01-kubernetes.md`](./01-kubernetes.md#migrations)).

## A role refuses an unapplied schema

`X_FRAMEWORK_SCHEMA_UNAPPLIED` or `X_APP_MIGRATIONS_UNAPPLIED` on a `web`, `sync`, `worker`,
`scheduler` or `replicator` boot: the framework stamp on `x_jobs` lacks this build's hash, or the
`x_migrations` ledger lacks a migration it ships. The role runs no DDL. It waits for the migrate
step, unready, with one `ultimate schema waiting` line, for up to `ULTIMATE_SCHEMA_WAIT_MS` (default
300000), then exits with the code — `meta.waitedMs` says how long — and the platform restarts it
([deploy contract](./07-deploy-contract.md#a-role-over-a-schema-that-is-behind)). Alert:
[UltimateSchemaUnapplied](#ultimateschemaunapplied); a fleet across a major,
[UltimateVersionSkew](#ultimateversionskew).

| Situation | Do |
|---|---|
| a rollout is in progress and its migrate Job is still running | nothing: the roles serve once it finishes (`kubectl get jobs -l app.kubernetes.io/component=migrate`) |
| the migrate Job failed | [a migration failed mid-deploy](#a-migration-failed-mid-deploy) — fix the migration, the roles follow |
| no migrate ran: an applier that drops Helm hooks, a compose `up` without the `run --rm migrate` step, a PaaS with no release phase | run it once against the same database: `x db migrate --json`, or the image with `ROLE=migrate`. Then wire the order: [deploy contract](./07-deploy-contract.md#order-migrate-before-roles) |
| the cause names a newer major as the newest applied build | refused at once, no wait: an old-major role over a database a newer release migrated. Roll forward to that release (`x deploy --image <newer> --json`), never migrate the old one over it |
| a migrate Job that is merely slow, past the wait | raise `ULTIMATE_SCHEMA_WAIT_MS` on the serving roles; `0` turns the wait off and refuses at once |
| rehearsing it | `x drill roll-before-migrate --json` plays this failure on a scratch database for `web`, `worker` and `scheduler` ([deploy contract](./07-deploy-contract.md#failures-their-alert-and-their-runbook)) |
| `ultimate framework major skew` in the logs, no refusal | a fleet across a major mid-rollout or mid-rollback; it serves. Finish the rollout: `kubectl rollout status deployment --selector app.kubernetes.io/component=web` |

## A credential leaked

| # | Step |
|---|---|
| 1 | **Contain before investigating.** Remove the access path — drop the key, deactivate the identity, scale a compromised workload to zero **in git** so the reconciler does not restore it |
| 2 | **Coordinate before rotating anything shared.** A blind rotation invalidates every copy at once, including legitimate consumers. Announce, pick a window, migrate dependents, then rotate |
| 3 | Enumerate the real blast radius by sweeping **live** Secret values, not the repo. Sealed ciphertext is namespace-scoped, so identical plaintext seals to different blobs and a git diff proves nothing |
| 4 | Re-seal everything the leaked identity could read |
| 5 | Remove the structural cause: a bind-mounted token, a shared service account, a personal credential doing a service credential's job |
| 6 | Write the postmortem — see [`05-disaster-recovery.md`](./05-disaster-recovery.md) |

Two priors worth holding: a **personal** credential used as a **service** credential is the most
common root cause, and a credential that lives as a plain file on a host appears in **no** manifest
audit — which is exactly why it goes unnoticed.

## A node went `NotReady`

Before you touch the node, confirm it is actually down. A blocked scrape path presents identically
to a dead node if your alert is sourced from a scrape rather than from the node controller — and an
alert that cannot self-clear turns its inhibition rule into a fleet-wide mute. Check node readiness
via the API server, then the kubelet, then the network path, in that order.

If it is genuinely down: workloads with `nodeAffinity` pinned to that node **will not reschedule**.
That is the cost of pinning, and it is the right trade for a database on a node-local volume — and
the wrong one for a stateless role.

## `db.pool.retired` in the logs

A statement had no answer past its statement timeout + 5 s, so the client replaced its pool. The app recovers on its own: this line is the evidence of what happened to the path, not a step to take.

| # | Step |
|---|---|
| 1 | one line after a node loss or a failover: expected, nothing to do. The statement it names answered `X_DB_UNAVAILABLE`; if it was an autocommit write, read the row before repeating it |
| 2 | repeating, one per bound: the database is still not answering. `psql "$DATABASE_URL" -c 'select 1'` from the same network; a paused or overloaded server looks the same as a dead path |
| 3 | requests failing with `X_DB_POOL_EXHAUSTED` and no such line: the pool is full, not gone. `x db diagnostics --json` (`data.activity.rows[]` per session, oldest transaction first; `data.slowQueries.rows[]` when `pg_stat_statements` is installed), then fix the slow statement or raise `DATABASE_POOL_MAX` |
| 4 | the statement is a transaction's (`insert`, `update`, `commit` …): a pinned statement is bound the same way, against the `statement_timeout` in force on its connection. Its transaction answered `X_DB_UNAVAILABLE` (`X_DB_COMMIT_UNKNOWN` for a `COMMIT`) and rolled back with the pool. A transaction that raised its own bound to `0` has no client deadline: `net.ipv4.tcp_retries2` on the node bounds it ([connection arithmetic](04-datastores.md#connection-arithmetic)) |
| 5 | a job retried after this code: `X_DB_UNAVAILABLE` is unclassified, so the worker re-runs the attempt, and an autocommit write that landed runs again. Make that write idempotent or put it in a transaction |

## Jobs are dead-lettered

A job that exhausted its retries is **kept**, never dropped: `queue_dead_jobs` counts them per queue.

| # | Step |
|---|---|
| 1 | `x jobs list --json` — the dead letters are listed per queue |
| 2 | `x jobs show <id> --json` — the attempts, each error's code, cause and `fix:` |
| 3 | fix the cause (the handler, a downstream, a bad input), deploy |
| 4 | `x jobs retry <id>` — the job runs again under its SAME idempotency key, so a partial side effect is not repeated |

Alert on `queue_dead_jobs > 0` rather than on the dead rate: a table that filled overnight and stopped
growing is a rate of zero ([`03-observability.md`](./03-observability.md)).

## The replication slot is accumulating WAL

A logical slot holds WAL until its consumer confirms it. The `replicator` confirms continuously; a
slot whose replicator is gone, crash-looping or on a different database keeps every WAL segment
since, until the disk fills and the **database** stops.

| Situation | Do |
|---|---|
| The replicator is down | bring it back — it resumes from the slot and the backlog drains. The slot is `REPLICATION_SLOT`, default `x_replicator` |
| The slot is orphaned (the app moved database, or `REPLICATION_SLOT` was renamed) | `SELECT pg_drop_replication_slot('<slot>');` — only after confirming no replicator will ever read it again; live clients re-snapshot |
| The disk is nearly full now | dropping the slot frees the WAL at the next checkpoint. That is the emergency brake; the replicator creates a fresh slot on its next start |

Watch `pg_replication_slots` (`active`, `confirmed_flush_lsn` against the current WAL position) from
postgres itself, or from `db_replication_slot_retained_bytes{slot}`, which the scheduler samples
every 15 s and [UltimateReplicationSlotRetention](#ultimatereplicationslotretention) alerts on.

## `X_SHUTDOWN_TIMEOUT` in the logs on every deploy

A drain hook — a handler, a job step, a socket teardown — was still running at the drain deadline
(`drain.deadlineMs` in `app.config.ts`, 25 s by default; on `ROLE=worker`, `drain.workerDeadlineMs` when declared) and was **abandoned**: the process exited without it.

The process then **exits 70** (`DRAIN_TIMEOUT_EXIT_CODE`, `EX_SOFTWARE`), never 0: a pod or container whose last state is `Completed (70)` / `Exited (70)` drained but abandoned work — a write may be half done. As of 2026-11, 70 is also the exit when the drain itself threw before its last phase, or when the role's own teardown (`app.stop()`) overran its budget. A clean drain exits 0. An alert on a non-zero exit after SIGTERM is this runbook.

| Situation | Do |
|---|---|
| A long request is expected | raise `drain: { deadlineMs }` in `app.config.ts` (1–3600000, every role). On Kubernetes `x deploy --method helm` carries it into the chart, which derives each role's `terminationGracePeriodSeconds` from it; on Compose raise `stop_grace_period` by hand to at least readiness grace + that deadline + 10 s |
| A long job step is expected on the worker | declare `drain: { workerDeadlineMs }` (1–86400000, `ROLE=worker` only, in place of `deadlineMs` there — which stays capped at an hour). `x deploy --method helm` passes it as `drain.workerDeadlineSeconds` and the chart sizes the worker's grace from it; on Compose raise the worker service's `stop_grace_period` to at least that budget + 10 s. A job that must never be cut off at all: the worker's retire ([Deployment](../../wiki/Deployment.md#retiring-a-worker-before-sigterm)) |
| A job holds its pod through a rollout | nothing to do: the worker's retire (`drain.workerRetireMs`, an hour by default) waits it out and the pod shows Terminating meanwhile. `X_JOB_OUTLASTS_DRAIN` in `x verify` names a job whose `timeout` is over that budget |
| It is not expected | the log line names the hook (`the "<name>" shutdown hook`): make it return once it stops accepting work, not once all work is done |
| Exit code 70 after a SIGTERM | the same finding, read off the platform: `kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}'` or `docker inspect -f '{{.State.ExitCode}}' <container>`. Find the `X_SHUTDOWN_TIMEOUT` line in that process's last logs and take the row above it that fits |

## Redis is down or stalled

`cache.tier.failed` lines with `tier: "redis"`, or `enqueue` refusing `X_DRIVER_UNAVAILABLE` on `redisJobDriver`. As of 2026-11 both share core's `redisClient()` (`@ultimat3/core/redis`): a command while the connection is down refuses at once, and the client reconnects with no pod restart, however long the outage.

| Log line or code | What happened | Do |
|---|---|---|
| `GET did not answer within 150 ms; reads skip the shared tier for 5000 ms` | the server accepted the command and did not answer (paused, swapping, a full network queue). Reads are misses served from Postgres; for 5 s after each missed deadline the tier is not asked at all | `redis-cli -u "$REDIS_URL" --latency`. Raise `redisTier({ commandTimeoutMs })` only if that latency is its normal |
| `Connection is closed and offline queue is disabled` | no connection: the server is stopped, restarting or unreachable. Every read is a miss in under a millisecond | `redis-cli -u "$REDIS_URL" PING`. When it answers `PONG` the pods reconnect on their own, within a few seconds |
| `X_CACHE_DRIVER_UNAVAILABLE` in an invalidation's `report.errors` | a bust (1,000 ms deadline, never skipped) did not land: rows it should have cleared serve until their TTL | once Redis answers, repeat the write that triggered it, or `invalidateTags(tags)` with the same tags |
| `X_DRIVER_UNAVAILABLE` from `enqueue` | nothing was queued. It is retryable: a job attempt that enqueues is re-run | the same `PING`; work that must not be lost is enqueued inside a transaction with the outbox installed: it is staged in Postgres and the relay publishes it once Redis answers |

Postgres takes the read load while the shared tier is gone: single-flight still holds per pod, not across pods. After a restore, keys newer than the restored rows survive in Redis: deploy with a new `APP_VERSION` so the namespace changes.

## The chart's alerts

`docker/helm/templates/alert-rules.yaml` (and the chart `x new` writes) links each rule's
`runbook_url` here. Every rule is scoped to one release in one namespace; `alerts.rules.<alert>` in
`values.yaml` overrides its `threshold`, `for`, `severity` or turns it off with `enabled: false`.

The Postgres rules read gauges ONE role samples, the scheduler, every 15 s
(`startRolePgStats`, `packages/cli/src/role-pg-stats.ts`), and only over an external database:
with no scheduler running they have no series and never fire. The schema rules read `framework_schema_applied` and
`framework_schema_major_skew`, which each serving role sets from its own stamp check
(`packages/core/src/schema-metrics.ts`).

### UltimateQueueStalled

`queue_oldest_ready_seconds` over the threshold (300 s) for 5 m: a due job nothing claims. Check that
a worker runs and serves that queue (`WORKER_QUEUES`), that it is Ready, and that `queue_demand` is
not pinned at the HPA's `maxReplicas`. A worker boot warns of a queue no worker serves
(`queue-unserved`).

### UltimateDeadLetters

`queue_dead_jobs` above zero for 5 m. Follow [Jobs are dead-lettered](#jobs-are-dead-lettered).

### UltimateLeaseLost

`job_leases_lost_total` rising for 5 m: the queue re-delivered a job its first worker was still
running, so its side effects may run twice. The usual cause is a blocked event loop or a starved
pod (CPU throttling, a long synchronous step): the lease could not be renewed in time. Read the
worker's `process_event_loop_lag_seconds` and its CPU limits; make the job's writes idempotent.

### UltimateFramesDropped

`channel_frames_dropped_total` rising for 5 m: sync nodes drop frames to clients whose sockets
cannot keep up, and those clients re-read. Check `connections` per pod against its ceiling and the
pods' CPU; scale `roles.sync` out before raising anything per pod.

### UltimateServerErrors

More than the threshold (5 %) of `http_requests_total` answered `5xx` for 10 m. The logs carry each
error's `X_*` code; group by it, and if the share rose with a rollout,
[roll back the image](#roll-back-a-bad-image).

### UltimateErrorBudgetFastBurn

The 5xx share of `http_requests_total` is above 14.4 × the error budget over BOTH the last hour and
the last 5 m, for 2 m: at this rate a 30-day budget (`alerts.objective`, default 99.9 %) is 2 %
gone in an hour. The short window resets it minutes after the fault stops. A rollout in the hour:
[roll back the image](#roll-back-a-bad-image). Otherwise group the logs by `X_*` code.

### UltimateErrorBudgetSlowBurn

The same ratio above 6 × the budget over 6 h and 30 m, for 15 m: 5 % of the budget in six hours.
Not a page-now fault — a slow leak (one route, one dependency). Break `http_requests_total` down by
`route`; set `alerts.objective` to your real target rather than raising the factor.

### UltimateJobFailures

More than the threshold (10 %) of a queue's runs on `jobs_total` ended `failed` or `dead` over
15 m, for 15 m. Read the worker's logs for the job's `X_*` code; a dependency outage shows on every
queue at once. Dead ones also raise [UltimateDeadLetters](#ultimatedeadletters).

### UltimatePoolSaturated

`db_pool_waiting` above zero on one pod for 5 m: statements queue for a connection because the
pool is at `db_pool_max`. A slow statement holds connections — read
`db_client_operation_duration_seconds` first; raise the pool only if Postgres' `max_connections`
has room for every pod's pool.

### UltimateEventLoopLag

The p99 of `process_event_loop_lag_seconds` above the threshold (0.5 s) on one pod for 10 m: its
timers run late, so leases, heartbeats and probes do too. A long synchronous step, or a CPU limit
throttling the pod; compare `process_cpu_seconds_total` with the limit.

### UltimateMemoryNearLimit

`process_resident_memory_bytes` above the threshold (90 %) of `process_memory_limit_bytes` (the
cgroup `memory.max`) on one pod for 10 m: the next growth is an OOMKill. Growth after a deploy is a
leak to bisect; flat and high is a limit set below the role's working set — raise
`roles.<role>.resources.limits.memory`. A pod with no limit emits no limit series and never fires.

### UltimateTargetDown

A scrape target of one role (`app_kubernetes_io_component`) reads `up == 0` for 5 m: the pod is
gone, crash-looping, or its `metrics` port is fenced off. List the role's pods with
`kubectl get pods -l app.kubernetes.io/component=<role>`; a Running pod still down is
`networkPolicy.metricsFrom` not admitting the Prometheus namespace.

### UltimateRequestLatency

The release-wide p95 of `http_request_duration_seconds` above 1 s for 10 m. A floor the app
overrides (`alerts.rules.UltimateRequestLatency.threshold`), not a per-route target: the chart
dashboard's per-route panel says which route moved. One route: its statement or its downstream
(`x db diagnostics --json`, `data.slowQueries` when `pg_stat_statements` is installed). Every route
at once: the pool, the database or CPU — read [UltimatePoolSaturated](#ultimatepoolsaturated) and
[UltimateEventLoopLag](#ultimateeventlooplag) first. A rise with a rollout:
[roll back the image](#roll-back-a-bad-image).

### UltimateConnectionsNearMax

`db_server_connections` above 80 % of `db_server_max_connections` for 10 m: the next pod to start
is refused `53300`. Every pod opens up to its role's pool (`DATABASE_POOL_MAX`), so the ceiling is
pods × pool ([connection arithmetic](04-datastores.md#connection-arithmetic)). Lower
`DATABASE_POOL_MAX`, cap the HPA's `maxReplicas`, or put a pooler in front
([Deployment](../../wiki/Deployment.md#through-a-connection-pooler)); raise `max_connections` only
with the memory for it.

### UltimateLongTransaction

`db_longest_transaction_seconds` above 300 for 5 m: a transaction that holds locks a migration
waits on and stops vacuum reclaiming every row newer than it. `x db diagnostics --json`:
`data.activity.rows[]` lists sessions oldest transaction first, `data.blockers.rows[]` what each
blocks. End it with `psql "$DATABASE_URL" -c 'select pg_terminate_backend(<pid>)'`, then find the
code that left it open.

**Grant the scheduler's database role the right to see every session**, or this rule is blind to the
transactions that matter most:

```sql
GRANT pg_read_all_stats TO <app role>;   -- or pg_monitor, which includes it
```

Without it Postgres hides another role's `xact_start` in `pg_stat_activity`, so the gauge reads only
the app role's own transactions: a superuser or DBA session, or a separate migrate role, holding a
transaction open reads `0` (`PG_SERVER_STATS_SQL`, `packages/db/src/pg-stats-sql.ts`). It counts this
database's sessions only. `x db diagnostics` reads `pg_stat_activity` under the same rule.

### UltimateAutovacuumLag

`db_autovacuum_backlog_ratio` above 2 for 30 m: the worst table's dead tuples exceed twice the
count that triggers its autovacuum. Not "autovacuum has not run" — it ran and is not keeping up,
or cannot reclaim. `x db diagnostics --json`: `data.deadTuples.rows[]` names the table, its `dead`
count and `autovacuumAgeSeconds`. A [long transaction](#ultimatelongtransaction) is the usual
cause, since vacuum cannot pass it; otherwise lower that table's `autovacuum_vacuum_scale_factor`.

### UltimateReplicationSlotRetention

`db_replication_slot_retained_bytes` above 1 GiB on one `slot` for 15 m: its consumer is down,
crash-looping or pointed at another database, and the disk fills behind it. Follow
[the replication slot is accumulating WAL](#the-replication-slot-is-accumulating-wal).

### UltimateDbStatsStale

`db_stats_sample_ok == 0` for 15 m: the scheduler's Postgres stats sample keeps failing, so the
four rules above it — connections, long transactions, autovacuum, slot retention — read the last
good values and stay quiet. Each failed round logs `db.stats.sample-failed` with the cause on the
scheduler: `kubectl logs -l app.kubernetes.io/component=scheduler`. A permission error on a
statistics view is the role's grants (see [UltimateLongTransaction](#ultimatelongtransaction));
a timeout is the database itself.

### UltimateSchemaUnapplied

`framework_schema_applied == 0` on a role for 10 m, **critical**: its pods are waiting on, or
refused, a database missing its build's framework schema (`X_FRAMEWORK_SCHEMA_UNAPPLIED`) or the
app migrations it ships (`X_APP_MIGRATIONS_UNAPPLIED`): `x db status --json`, then `x db migrate`.
Follow
[a role refuses an unapplied schema](#a-role-refuses-an-unapplied-schema).

### UltimateVersionSkew

`framework_schema_major_skew` above 0 for 30 m: a role serves a build whose major differs from
the newest build that applied the framework schema, and the log carries
`ultimate framework major skew`. Mid-rollout it clears on its own; 30 m later it is a rollout that
stalled or a rollback left half done. `kubectl rollout status deployment --selector
app.kubernetes.io/component=<role>` for each role; finish the rollout, or
[roll back](#roll-back-a-bad-image) every role to one build.

### UltimateVolumeNearFull

A PersistentVolumeClaim in the release's namespace over 85 % of its capacity
(`kubelet_volume_stats_used_bytes` ÷ `kubelet_volume_stats_capacity_bytes`) for 15 m. A database
volume: the WAL first ([UltimateReplicationSlotRetention](#ultimatereplicationslotretention)),
then table bloat ([UltimateAutovacuumLag](#ultimateautovacuumlag)). Grow the claim before it
fills: a full Postgres volume stops every write.
