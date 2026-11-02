# 33-ops-worker-roll — A deploy never cuts a running job, and scaling reads real demand

> Part of [`overview.md`](overview.md). Depends on: [`19`](19-cli-deploy-verify.md) for nothing but sequence. Tier: 0 (`core`), 3 (`jobs`), 5 (`cli`), plus `docker/helm`.

## Why
Owner goal: a worker mid-job finishes and takes no new work, then is replaced. Today that is off by default.

| Hole | Evidence |
|---|---|
| A job outliving 25 s is cut on every deploy | `roles.worker.retireSeconds: 0` (`docker/helm/values.yaml`), drain default 25 s (`core/src/config-defaults.ts:60`); cut-off counted `interrupted` (`jobs/src/worker-drain-finish.test.ts:259`) |
| The retire is outside `app.config.ts` | `helmDrainOverrides` carries the drain budgets, never the retire (`cli/src/cmd-deploy-drain.ts:23-35`); hand-set `--set` per `wiki/Deployment.md:106` |
| Nothing compares a job's limit with the budget | `timeoutMs` is on the manifest (`jobs/src/inspect.ts:283`); no check reads it. One adopter pins this in two test files |
| The chart's worker HPA shrinks a busy fleet | probe: 10 jobs held, `driver.stats()` gives `ready: 0, running: 10`, and `worker-queue-depth.ts` publishes `ready`, so `queue_depth` is 0 and `ceil(0/100)` asks for `minReplicas: 1`. The framework says so itself (`jobs/src/scaler-depth-fixture.ts:3`), yet ships that default (`values.yaml`, `SCALING_METRICS` at `core/src/runtime-metrics.ts:20`) |
| A deploy inflates demand | one adopter counted a draining worker's runs and averaged 1.84 pods where one carried the load, 7 days at ~50 deploys a day; hence the exclusion in `SQL_SCALER_DEPTH` |

A scale-down is the same stop as a deploy, so hole 4 cuts jobs under hole 1's budget.

## Decisions
| Question | Answer |
|---|---|
| Default | retire on. `drain.workerRetireMs`, default 3,600,000; 0 turns it off. An idle worker exits at once, so it costs only while a job really holds a pod |
| Why not `workerDeadlineMs` | a different thing: that bounds a SIGTERM drain, then aborts. Retire aborts nothing |
| Does a held pod block a rollout | no. A terminating pod does not count against rollout completion; new pods claim at once |
| Compose | stays SIGTERM with `stop_grace_period`. No `preStop`, and SIGKILL mid-job is worse than a handed-back claim. Single-node rung, no such claim (`docs/idea/17-scale-ladder.md`) |
| A job with no `timeout` | not graded. A limit nobody declared is not comparable |
| New series or a formula for the adapter | new series `queue_demand{queue}`. `max(queue_depth) + sum(job_worker_in_flight)` counts draining workers, and only Postgres knows who drains |
| `queue_depth` | stays, unchanged: the backlog alert reads it. Only the chart's worker default moves |
| Flip HPAs off by default | no. Read as `<unknown>` an HPA holds `minReplicas`; noise, no harm. `docs/ops/03-observability.md:70` stands |
| Omit `replicas` under an HPA | already shipped (`docker/helm/templates/deployments.yaml:24`) |

## Files to change
- `packages/core/src/config-health.ts:53`, `config-defaults.ts:62`, `drain-deadline.ts:62` — `workerRetireMs`, screened, 0 to a day.
- `packages/cli/src/cmd-deploy-drain.ts:23` — `--set roles.worker.retireSeconds=<n>`.
- `docker/helm/values.yaml`, `packages/cli/src/templates/scaffold-helm.ts:186` — `retireSeconds: 3600`; worker `metric: queue_demand`; `targetAverageValue` comment says set it to one pod's `maxInFlight`.
- `packages/cli/src/cmd-deploy-helm.ts` — pass `jobs.maxInFlight` as the worker's `targetAverageValue` when declared.
- `packages/jobs/src/driver.ts` — optional `demand?(): Promise<readonly { queue: string; demand: number }[]>`.
- `packages/jobs/src/driver-pg-sql` beside `SQL_STATS` — grouped form of the statement in `scaler-depth-fixture.ts`; the fixture and README test then read that one statement.
- `packages/jobs/src/driver-memory.ts` — same answer over its rows. A custom driver without it falls back to `ready + running`.
- `packages/jobs/src/metrics.ts`, `worker-queue-depth.ts:62` — `queueDemand`, zeroed like its siblings.
- `packages/core/src/runtime-metrics.ts:20` — `'queue-depth'` maps to `queue_demand`; rename the signal only if `wiki/Observability.md:103` cannot state it plainly.
- `packages/cli/src/verify-checks.ts`, `packages/cli/src/job-budget.ts` (new) — the check, in the `manifest` step, read from the app manifest.
- `scripts/helm-drain.test.ts`, `templates/scaffold-helm-retire.test.ts`, `scaffold-helm.test.ts:68-71`.
- `wiki/Deployment.md:93-110`, `wiki/Observability.md:99-103`, `wiki/Jobs-And-Workflows.md`, `docs/ops/03-observability.md:32,70-78`, `docs/ops/README.md:123`, `docs/ops/06-runbooks.md:195`, `packages/jobs/README.md:1066-1074,1299`, `packages/cli/README.md`.

## Steps
1. `bun run new-error-code X_JOB_OUTLASTS_DRAIN --package cli --off-socket --title '…' --cause '…' --fix '…'`.
2. Config and `x deploy` carry. Chart default and scaffold default together; parity test holds them.
3. Check: for each job with `timeoutMs`, budget is `workerRetireMs` when above 0, else `workerDeadlineMs ?? deadlineMs`. Over budget raises the code, naming job, limit and budget.
4. `driver.demand()`, published on the depth interval with no extra round when the driver lacks it.
5. Chart default moves; docs give the adapter rule `max by (queue) (queue_demand)` beside the existing `rps` rule.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_JOB_OUTLASTS_DRAIN` (off-socket) | a job's declared `timeout` exceeds the worker's budget, so a deploy cuts it | `set drain: { workerRetireMs: <at least timeout> } in app.config.ts, then x verify --only manifest` |

## Tests
- `packages/jobs/src/worker-queue-demand.test.ts` (unit): the probe above. 10 held gives `queue_demand` 10, `queue_depth` 0. Fails today: no such series.
- `packages/jobs/src/scaler-depth.job.test.ts`: the grouped form agrees with the fixture's counts; a draining worker's runs are out.
- `packages/cli/src/cmd-deploy-drain.test.ts`: the `--set` pair; 0 sends 0.
- `packages/cli/src/job-budget.test.ts` (unit): over, under, equal, no timeout, retire off.
- `packages/cli/src/templates/scaffold-helm-retire.test.ts`: default render has the SIGUSR2 `preStop` and grace above 3600.
- `bun test packages/jobs/src/worker-queue-demand.test.ts`

## Semver
**Breaking, three rows.** `X_JOB_OUTLASTS_DRAIN` is a new red verdict in `manifest`; `SCALING_METRICS` is an exported constant and changes; `drain.workerRetireMs` turns retire on by default. Observable: rollouts leave an old worker Terminating while it holds a job. An app's own chart keeps its values until `x deploy` sets the retire, and its HPA metric until edited.
Upgrading: "A job whose `timeout` outlasts the worker's budget reds `manifest`: raise `drain.workerRetireMs` or lower the `timeout`. `SCALING_METRICS['queue-depth']` is `queue_demand`: add the adapter rule `max by (queue) (queue_demand)`. `workerRetireMs: 0` keeps the old stop."

## Done when
- A scaffolded chart with no overrides renders the retire, and the worker HPA reads `queue_demand`.
- `x verify` fails naming a job with `timeout: '2h'` and `workerRetireMs: 0`.
- `queue_demand` equals held plus due on both drivers, excluding a draining worker on Postgres.
- [`33-ops-deploy-proof.md`](33-ops-deploy-proof.md) proves it on a cluster.
- `bun run verify` green.
