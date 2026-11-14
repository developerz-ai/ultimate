# 09 — The deploy contract

> Part of [`overview.md`](overview.md). Depends on: [`05`](05-jobs-realtime.md) J5. Tier: 5 + chart.

## Files to change
- `docker/helm/templates/` — D1. On every demo rollout (8 observed, 30.9 → 31.13.1) the sync and replicator roles start before migrate has run, log `X_FRAMEWORK_SCHEMA_UNAPPLIED` and a major-skew warning, and crash-loop until it does. The deployed adopter fixed it for itself with an ordered migrate Job.
- `packages/cli/src/framework-schema-stamp.ts` + role boot — D2. A role facing an unapplied schema exits.
- `docker/helm/templates/` probes — D3. Liveness on `/metrics` for worker, scheduler, replicator.
- Chart alert generators (2026/11/11 slice 20) + `docker/helm/dashboards` — D4. Missing: dead jobs and queue stalled for every app, p95 latency, replication-slot retention, connections against max, long transactions, autovacuum lag, schema unapplied / version skew, volume usage; no severity on tracker alerts.
- `docs/ops/` — the contract page and its runbooks.

## Steps
1. D1: the chart runs migrate as a gating Job (a pre-upgrade hook, and an ordered resource for GitOps controllers that ignore hooks); every role's rollout waits on it. One mechanism in the chart; the per-pod init container goes.
2. D2: a role that finds the schema behind waits with bounded backoff and one log line (`logRepeated`, [`02`](02-core.md) C7), then exits with the code after a declared deadline. Ahead-of-schema by a major still refuses at once. Containers only: no controller-specific API in the framework.
3. D3: liveness → the heartbeat route from J5; readiness unchanged.
4. D4: generate each missing rule from the metrics the framework already emits; where a rule needs a series that does not exist (replication lag), add the gauge first. Rules carry `severity`; a retried job is never page-worthy.
5. Write `docs/ops/` "what a deploy guarantees": order, drain, skew window, rollback, the alert each failure raises and its runbook.

## Tests
- `x drill` gains a fourth fault: roll roles before migrate. Pass = no crash-loop, roles serve after migrate, one log line per role.
- `helm template` golden tests for the Job, probes and rules; `helm lint`.
- `fault-drills` CI job runs the new drill against real Postgres.

## Done when
- A demo rollout shows zero restarts and zero `X_FRAMEWORK_SCHEMA_UNAPPLIED` lines ([`30`](30-infra.md) I5 adopts the chart change).
- Every rule in D4 exists for both deployed apps and each links a runbook.
