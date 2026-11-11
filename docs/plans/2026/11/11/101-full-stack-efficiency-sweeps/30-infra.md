# 30 — Infrastructure: evidence an agent can read, alerts and dashboards for both apps

> Part of [`overview.md`](overview.md). **Edited from `../infrastructure`, never from this repo**, by an agent started there under its own `CLAUDE.md`. Depends on: [`20`](20-ops-defaults.md) for I4/I5 (generated rules and dashboard); nothing for the rest. Tier: n/a.

## Findings (read-only probe 2026-11-11)

Probe limits, each a finding below: the demo database's statistics were unreadable, pod logs reached back 25–49 minutes, table counters are lifetime.

| # | Sev | Where (infrastructure repo) | Finding | Fix |
|---|---|---|---|---|
| I1 | High | `scripts/lib/db/stats.ts:33-40`; `stacks/apps/ultimate-social/manifests/db-cluster.yml` | The SELECT-only stats script registers only the shared cluster. The demo's own cluster has no `stats_reader` role, no `pg_ident` line, no `pg_stat_statements`: `unknown cluster` | register the demo cluster; add the role, the ident map and the extension to its manifest |
| I2 | Med | `scripts/lib/db/stats.ts` | `pg_stat_user_tables` counters are lifetime; only statement stats were reset after v31. No table-level baseline exists | a dated snapshot verb (`--snapshot` writes JSON under `records/`), and a `--since <snapshot>` diff |
| I3 | High | `scripts/obs/` | No read path for logs older than the current pods. With 8–11 rollouts a day, `kubectl logs` holds under an hour. Loki runs (`stacks/platform/observability/loki`) | a read-only LogQL verb (`scripts/obs/logs.ts --app <name> --since 48h --json`), read-scoped token |
| I4 | Med | `stacks/apps/ultimate-social/manifests/` | The demo has two PITR rules and a blackbox probe, no app alerts. A sibling app hand-wrote 24 rules | apply the PrometheusRule that [`20`](20-ops-defaults.md) generates from the chart (5xx rate, p95 latency, job failure rate, queue latency, pool saturation, replication lag, event-loop lag) |
| I5 | Med | `stacks/platform/observability/grafana/dashboards/` | No dashboard for either framework app, though both have a ServiceMonitor | provision the dashboard JSON [`20`](20-ops-defaults.md) ships |
| I6 | Low | `stacks/apps/*/manifests/deployment-*.yml` | Requests off the measured use: demo web requests 256 Mi and uses 73, worker 192 / 58; a sibling app's scheduler and sync run above their requests (249 / 224, 253 / 192) | set requests from a 7-day p95 once I3/I5 exist |
| I7 | Med | node `worker-2` | Every container on one node restarted at 2026-11-11 01:16:05 UTC with exit 255, the demo's single-instance database among them. Untraced | read the node's kubelet and runtime journal; record the cause under `records/` |
| I8 | Low | shared Postgres cluster | A stale `ultimate_social` database (11 MB, no backends) is still scraped; its cleanup is already pending in `stacks/apps/ultimate-social/README.md` | drop it after a final dump |
| I9 | Med | `stacks/stateful/postgres-instance/manifests/cluster.yml` | `idle_in_transaction_session_timeout` is 0 | set 60 s (the framework's own transactions are bounded by `lock_timeout` and the request deadline) |
| I10 | Low | `scripts/lib/db/stats.ts` | Each JSON-wrapped stats query writes ~22,000 temp blocks and takes ~1 s, so the script ranks in its own temp-block evidence | `set local work_mem` for the session, or tag and filter its own `queryid`s |
| I11 | Low | metrics exporter config | The exporter's extension-version query is the fourth most expensive statement in an app database (3.1 s exec + 2.8 s plan per day, per database) | lengthen that collector's interval or drop it |
| I12 | Low | `scripts/glitchtip/` | Two synthetic ingest-probe issues sit unresolved in the demo's project | the probe resolves its own issue |
| I13 | Med | both apps' Deployments | Each rollout restarts all five roles and logs first-probe `Startup probe failed: connection refused`; the replicator reconnects its slot every time (12 slot restarts and 9 `Connection reset by peer` in 13.7 h) | `initialDelaySeconds` from the measured boot (demo 0.7–1.4 s); roll the replicator only when its image digest or config hash changed; recheck after [`10`](10-realtime.md) closes the walsender cleanly |

## Steps
1. I1, I3 first: they are what every later audit reads. Re-run the probe's statement and table queries against the demo once I1 lands and hand the output to the coordinator of this plan (it feeds [`09`](09-jobs.md)'s before/after).
2. I2 before the framework release that carries [`09`](09-jobs.md): take the dated snapshot, so the idle-cost claims have a baseline.
3. I7, I9, I13: independent, one PR each.
4. I4, I5 after [`20`](20-ops-defaults.md) ships. I6 a week after I5.
5. I8, I10, I11, I12: one cleanup PR.

## Tests
- That repository's own gate.
- I1: `scripts/db/sql.ts`-family stats command exits 0 against both clusters with `--json`.
- I3: the log verb returns lines older than the oldest running pod.

## Done when
- An agent reads statements, table stats, 48 h of logs and error-tracker issues for both apps with no `kubectl exec` and no superuser.
- Both apps alert on the seven generated rules and have a dashboard.
- A dated before/after snapshot pair exists for [`09`](09-jobs.md): framework statements' share of WAL and calls per hour at idle.
