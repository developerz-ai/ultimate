# 20 — Ops defaults: alerts, a dashboard and log levels every app gets for free

> Part of [`overview.md`](overview.md). Depends on: [`03`](03-db.md) D1, [`06`](06-http.md) H6 (the two slow lines), [`09`](09-jobs.md) J10. Tier: `docker/helm`, `cli` (tier 5), one gauge in `core` (tier 0). Consumed by [`30`](30-infra.md) I4/I5.

Production: the demo has no app alerts and neither app has a dashboard; a sibling app hand-wrote 24 alert rules. Axiom 7 holds: the chart ships *rules and JSON*, never a platform primitive in a package.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| O1 | P2 | partial (catalogue) | `docker/helm/templates/alert-rules.yaml:77-80` (a flat 5%-for-10-minutes threshold); `x g chart-alerts` exists | No burn-rate alerting | multi-window burn rate over `http_requests_total` (1 h / 5 m fast, 6 h / 30 m slow), the objective a chart value (default 99.9). Plus the rules the adopter wrote by hand, as defaults: job failure rate, `queue_oldest_ready_seconds`, pool saturation (`db_pool_*`), replication lag, event-loop lag, RSS ÷ memory limit |
| O2 | P2 | absent | `docker/helm/` | No dashboard for a framework app | one Grafana dashboard JSON shipped in the chart (ConfigMap, opt-in value) over the stable semconv metric names: requests, latency by route, statements, pool, jobs, realtime, process. `x g chart-dashboard` emits it for a non-helm deploy. Phone-width first (owner goal 2026-10) |
| O3 | P3 | absent (catalogue) | `packages/core/src/process-metrics.ts:126` | No memory-limit gauge: an alert cannot say "90% of the limit" | `process_memory_limit_bytes` read from `/sys/fs/cgroup/memory.max` (absent file → the gauge is not emitted) |
| O4 | P3 | confirmed (production logs) | per-unit `info` lines: `packages/jobs/src/scheduler.ts:191` (88% of a scheduler pod's lines), the HTTP refusal line, `mcp.auth.missing-token` at `warn` | No stated level policy; each package chose | the policy, written once in `docs/architecture/00-conventions.md` and enforced: a routine per-unit event is `debug`; `info` is lifecycle and rare outcomes; `warn` needs an operator action. Guard `scripts/log-levels.ts`: a `logger.info(` inside a per-request / per-job / per-fire path (the stage and executor files, listed) is a finding unless annotated `// info: <why>`. The three known sites are fixed in their own slices ([`09`](09-jobs.md) J10, [`06`](06-http.md) H7, [`12`](12-notify-ai-mcp-pwa.md) M4) |
| O5 | P3 | confirmed (production) | `packages/cli/src/serve-boot.ts` | 5–8 boot lines per role; no timeline | one `boot.phase {name, ms}` line per phase and one summary line ([`14`](14-cli-commands-upgrade.md) U12 owns the code; listed here for the dashboard's boot panel) |
| O6 | P3 | measured | chart resource defaults | The demo requests 256 Mi for a web role that uses 73 Mi | chart defaults from the measured idle + headroom (web 128 Mi, worker 96 Mi, scheduler/sync/replicator 96 Mi), stated as measurements with the date |

## Files to change
- `docker/helm/templates/alert-rules.yaml`, `values.yaml`, `templates/dashboard-configmap.yaml` (new), `docker/helm/dashboards/ultimate-app.json` (new).
- `packages/cli/src/templates/chart-alerts*.ts`, `chart-dashboard.ts` (new), `generate-kinds.ts`.
- `packages/core/src/process-metrics.ts` — O3.
- `scripts/log-levels.ts`, `scripts/log-levels.test.ts` (new); `docs/architecture/00-conventions.md`.
- `docs/ops/` observability page.
- Coordinator only: a code for the log-level guard via `bun run new-error-code`, `guards-doc.ts --write`, `bun run manifest`.

## Steps
1. O1: `chart-alerts.test.ts` renders the rules; `promtool check rules` in CI if the tool is on the runner, else a structural test.
2. O2: build the dashboard against the local test stack's metrics endpoint; every panel's query must return a series from `examples/dummy` under a short load.
3. O4: the guard lands report-only with the count; the three known sites go first.
4. Hand the rendered rule file and the dashboard JSON to the infrastructure slice.

## Tests
- `packages/cli/src/chart-alerts.test.ts` — burn-rate windows present; the objective is a value.
- `packages/cli/src/chart-dashboard.test.ts` — every panel names a metric that `packages/core/src/metrics-semconv.ts` declares.
- `packages/core/src/process-metrics.test.ts` — a fixture cgroup file yields the gauge; no file, no gauge.
- `scripts/log-levels.test.ts` — an `info` in a per-request file is a finding; an annotated one is not.
- Command: `bun test ./packages/cli/src/<file>.test.ts`.

## Done when
- A fresh `helm install` of any app alerts on burn rate, job failures, queue latency, pool saturation and memory, and shows one dashboard.
- A scheduler pod at idle logs under ten lines an hour.
