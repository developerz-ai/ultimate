# 26 — Infrastructure: drills green, errors and stats readable, telemetry landing

> Part of [`overview.md`](overview.md). **Edited from `../infrastructure`, never from this repo.** Depends on: [`20`](20-observability.md) for the OTLP items. Run by an agent started in that repo, under its own `CLAUDE.md`.

## Findings (read-only probes 2026-11-09)
| # | Sev | Where | Finding | Fix |
|---|---|---|---|---|
| F1 | **High (ops)** | `postgres` namespace | `pg-logical-restore-drill` Failed (1 day ago); `pg-pitr-restore-check` Failed (43 days ago). Backups are unproven | read both jobs' logs; fix; schedule; alert on failure |
| F2 | Med | `ultimate-social-db` (CNPG) | `OS distribution is not supported` (bullseye; supported until 2026-08-31) | move to the supported image line |
| F3 | Med | repo scripts | `scripts/db/sql.ts` reaches only the shared `postgres` cluster (`scripts/lib/db/sql.ts:12-13`) through superuser `kubectl exec`; `ultimate-social-db` has no read path | a read-only role + a SELECT-only script per CNPG cluster, so agents can read `pg_stat_statements` without exec as superuser |
| F4 | Med | GlitchTip | no agent read path: `scripts/lib/glitchtip/_client.ts:59-60` needs `GLITCHTIP_API_TOKEN`, absent from `.env` | a read-only API token in the infra `.env` (owner mints it) + `scripts/glitchtip/issues.ts` listing unresolved issues per project, 14 days, top by count, frames included |
| F5 | Med | demo replicator | 13 `x_replicator` slot restarts and walsender "replication timeout" in 32 h; 10 "connection reset by peer" | after [`13`](13-realtime.md) R2/R4 ship, recheck; meanwhile inspect `wal_sender_timeout`, NetworkPolicy/conntrack timeouts between the replicator pod and the DB |
| F6 | Med | telemetry | spans exist but production has no DB spans until [`20`](20-observability.md); no OTLP logs | point both apps' `OTEL_EXPORTER_OTLP_ENDPOINT` at the LGTM collector; dashboards on stable semconv names; alerts: 5xx rate, p95 latency, job failure rate, replication lag, pool saturation |
| F7 | Low | demo + adopter E | `pg_stat_statements` last reset 2026-10-06 | reset after v31 rolls out, to get a clean baseline |
| F8 | Low | egress | default deny egress to metadata ranges | roll the new chart default from [`25`](25-helm-docker.md) |

## Steps
1. F1 first: a red backup drill outranks everything here.
2. F3, F4: so the next audit can read stats and errors without asking.
3. F6 after [`20`](20-observability.md) ships; F5 after [`13`](13-realtime.md).

## Done when
- Both drills green on their schedule; an agent can run `scripts/glitchtip/issues.ts --json` and a SELECT-only stats script against both clusters.
