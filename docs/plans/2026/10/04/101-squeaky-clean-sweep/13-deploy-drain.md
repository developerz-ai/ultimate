# 13 — Zero-downtime, frequent deploys: a working worker finishes, then restarts

> Part of [`overview.md`](overview.md). Added by the owner 2026-10-05: "fast deployments so we can do
> multiple per day … pending workers (working) won't receive new work until finished and updated and
> restarted … without cancelling existing work". **Sweep 8c**, after 8b, before 9. Read-only
> concurrency audit at `836ecb02`, 2026-10-05 (the evidence below).

## Rule
A deploy never cuts off work in flight, on any role. On the stop signal a role stops TAKING work,
finishes what it holds within a configured budget, hands back what it cannot finish so another
process takes it at once, then exits. A new deploy queues behind one in flight; it never cancels it.

## Already sound (keep; pin with tests where missing)
- **Web:** `/readyz` goes 503 for `readinessGraceMs`, `/healthz` stays 200, in-flight requests and
  streams are awaited, and drain-time requests are served with `connection: close`
  (`http/src/server.ts:337,379`, `stages.ts:150-154`).
- **Sync:** upgrades are refused, each client gets a jittered `reconnect` frame (`sync-node.ts:436-473`).
- **Scheduler:** releases the leader lease only after its round settles, so it never double-fires
  (`scheduler.ts:414-425`).
- **Deploy concurrency:** `deploy-social-demo.yml` and `release.yml` use `cancel-in-progress: false`;
  release is one global queue since 8b.
- **Helm:** `maxUnavailable: 0`, `maxSurge: 1`, preStop on web and sync, a PDB, a 45 s grace.

## Findings → fix

| # | Sev | Where | Defect | Fix | Test |
|---|---|---|---|---|---|
| D1 | Critical | `jobs/src/worker.ts:349`, `steps.ts:257-258` | Stop-accepting also CANCELS every running job (`JobDrainedError`). A step whose side effect completed during the drain is refused by `put`, and the next worker runs it again (probe: `effects 2`). Contradicts `wiki/Deployment.md:73` | Stop claiming at once; cancel the running jobs' signal only at `deadlineAt − margin`; `put` writes through when the abort reason is the drain (the store write is already fenced on the claim) | `worker-drain.test.ts`: a step finishing 10 ms after SIGTERM is recorded once; a job finishing inside the budget is acked, not handed back |
| D2 | High | `core/src/config-health.ts:31-39`, `cli/src/serve-drain.ts:10`, `serve-boot.ts:140` | A worker's drain budget is fixed at 25 s; `app.config.ts` cannot raise it | `drain.deadlineMs` beside `readinessGraceMs`, applied per role in `lifecycleForRole` | config + lifecycle tests |
| D3 | High | `jobs/src/worker.ts:368-375` | A job still running at the deadline keeps its lease; it is redelivered only after the 30 s visibility timeout | Before the driver closes, hand back the claims still held (`countsAsAttempt: false`, `worker-hand-back.ts`) | a held claim is visible to a second worker at once |
| D4 | Medium | `docker/helm/…/_helpers.tpl:175-184` | Worker and scheduler pods are Ready before their roles start, so a rollout can replace every old worker with ones that crash late in boot | readinessProbe on `/readyz` for every role; `minReadySeconds`; `terminationGracePeriodSeconds` derived per role from D2 | helm template tests |
| D5 | Medium | `db/src/migrate.ts:241`, `docs/ops/06-runbooks.md:130` | Rolling back to an older image fails the pre-upgrade migrate Job (`X_MIGRATION_CONFLICT` on ledger rows newer than the build) | The migrate role accepts a ledger whose unknown rows are all NEWER than the build (a rollback) and reports it; runbook updated | migrate test: newer-only unknown rows → ok + notice |
| D6 | Medium | `cli/src/cmd-deploy.ts:215`, `docs/ops/README.md:29` | Compose deploys stop the old container before the new one starts | Start-first: scale the new container up, wait for `/readyz`, then stop the old one; document the proxy requirement | cmd-deploy argv test |
| D7 | Low | `cli/src/hold.ts:51`, `role-start.ts` | SIGTERM during boot kills a worker that has already claimed jobs | Install the drain handlers before roles start | boot-signal test |
| D8 | Low | `wiki/Deployment.md:63` | Says `DRAIN_TIMEOUT` (default 30 s) and a `resumeFrom` frame; neither exists | Rewrite against D2 and the real frame | doc-paths / doc review |

## Done when
- A deploy under load (the `job`-step live suite plus a probe) loses no job, runs no step twice, and
  drops no request; the drain budget is configurable and the chart derives its grace period from it.
- `bun run verify` and the app gate are green; merged.
