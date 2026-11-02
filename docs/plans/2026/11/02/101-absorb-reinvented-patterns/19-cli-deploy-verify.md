# 19 — `x deploy verify`: production serves this build and stays there

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`jobs`), 5 (`cli`).

## Why
Four adopters built the same check (1,506 / 1,407 / ~450 / 1,068 LOC): does production serve this build, and does it hold. They roll through a GitOps controller, so `x deploy` (`cli/src/cmd-deploy-spec.ts:6`) never runs for them.
Parts exist, unassembled: the header on every health answer (`http/src/server.ts:226`, `wiki/Deployment.md:55`, which tells a deploy check to `curl` it by hand), `driver.introspect.workers()` (`cli/src/cmd-jobs.ts:108`). One incident: every pod Ready, no worker claimed a queue; the only signal is one warn line at boot (`cli/src/runtime-jobs.ts:107`).
A worker row names no build (`jobs/src/introspection.ts:132`), so a stalled worker roll stays invisible: the old pods still serve the queue while the web role is on the new build.

## Decisions
| Question | Answer |
|---|---|
| Version route | none. `x-ultimate-build` on `/readyz` already answers it; the body stays the stranger's verdict (#53) |
| SHA flag | `--build <id>`, because the header carries `BUILD_ID`, which is the manifest's hash (`cli/src/cmd-build.ts:88`) or whatever CI stamped. Default: `x.manifest.json`'s `buildId` |
| Pod coverage | sampled through the load balancer, a new connection each, and reported as samples. Never a claim about each pod: no platform API (axiom 7) |
| Queue-family wildcards | no. 29.0.0 refuses `WORKER_QUEUES` patterns at boot (`X_WORKER_QUEUE_UNKNOWN`, `cli/src/runtime-jobs.ts:123`), and a queue only `enqueue({ queue })` reaches must be in `jobs.queues`. The set is closed |
| Scale-to-zero workers | `--idle-ok <queue,…>`: exempt while its depth is 0. An autoscaled pool with no worker and no work is correct |
| No `DATABASE_URL` in the env | the queue grade reports `graded: false` and the summary says so, never counted as pass. Read from the env directly: `resolveServices` would fall back to the embedded database and grade an empty one |
| Vendor adapters | never (`docs/idea/14-roadmap.md:130`). HTTP and Postgres only |

## Files to change
- `packages/jobs/src/introspection.ts:132` — `WorkerAnnouncement.build?: string`, optional so a custom driver still compiles.
- `packages/jobs/src/driver-pg-ddl.ts:263` — `alter table x_job_workers add column if not exists build text`. `driver-pg-operator-sql.ts:154,176`, `driver-pg-operator.ts:260`, `driver-memory-operator.ts:280` — write and read it.
- `packages/jobs/src/worker-registry.ts:60` — announce the worker's build, from a new `jobWorker` option.
- `packages/cli/src/runtime-jobs.ts` — pass `config.buildId`.
- `packages/cli/src/cmd-deploy-spec.ts:6` — `subcommands: ['up', 'verify']`, `defaultSubcommand: 'up'`, so `x deploy --image …` is unchanged (`parse.ts:340`). `up` is the parser's name for the default: usage and every doc keep the one spelling. Flags scoped per subcommand (`parse.ts:27`).
- `packages/cli/src/cmd-deploy-verify.ts` (new) — the command: flags, grades, result.
- `packages/cli/src/deploy-verify-grade.ts` (new) — pure grading over samples and worker rows.
- `packages/cli/src/jobs-json.ts` — `build` on `workerToJson`.
- `wiki/CLI-Reference.md:750`, `wiki/Deployment.md:55` (replace the `curl` line), `docs/ops/01-kubernetes.md`, `docs/idea/11-topology.md:21`, `packages/cli/README.md`, `packages/cli/CLAUDE.md`, `packages/jobs/README.md`. No `examples/dummy` use: a command, not a primitive.

## Steps
1. `bun run new-error-code` for each code below.
2. `x deploy verify --url <origin> [--build <id>] [--window 60s] [--interval 5s] [--timeout 10m] [--idle-ok <q,…>] [--json]`.
3. Sampling: `GET <origin>/readyz`, `keepalive: false`, signal per sample (`AbortSignal.timeout`), redirects refused. A sample is good when 2xx and the header equals the build.
4. Stability: wait for the first good sample, then require `--window` of consecutive good ones. A bad sample restarts the window. `--timeout` ends the whole wait. `--window 0` is a value: the build answered once.
5. Failure class, from the samples' tally: never the build → `X_DEPLOY_BUILD_MISMATCH`; no header on a 2xx → `X_DEPLOY_BUILD_UNSTAMPED`; the build answered and the window never closed → `X_DEPLOY_UNSTABLE`.
6. Queues, after the window, when `DATABASE_URL` is set: expected set is `workerQueuesFor` (`cli/src/runtime-jobs.ts:93`) over the registered jobs and `jobs.queues`, via `loadApp`. A queue is served when one row is not draining and has this build. Otherwise `X_DEPLOY_QUEUE_UNSERVED`, unless on `--idle-ok` with depth 0.
7. Result: `{ build, samples: { total, good, byBuild, byStatus }, windowMs, queues: { graded, served, unserved, idle } }`. Each unserved queue names the running workers' builds, so a stalled roll reads as one.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_DEPLOY_BUILD_MISMATCH` (off-socket) | `--timeout` passed and no sample carried the build | `x deploy verify --url <origin> --build <id CI stamped> --json`; `meta.byBuild` names what answered |
| `X_DEPLOY_BUILD_UNSTAMPED` (off-socket) | 2xx with no `x-ultimate-build` | set `BUILD_ID` in the image: `x build --target docker` passes it |
| `X_DEPLOY_UNSTABLE` (off-socket) | the build answered, the window never closed | `x deploy verify --url <origin> --json`; `samples.byStatus`, `byBuild` name what interrupted it |
| `X_DEPLOY_QUEUE_UNSERVED` (off-socket) | a registered queue has no serving worker of this build | `x jobs list --json`, then `WORKER_QUEUES=<queue>` on a worker Deployment, or `--idle-ok <queue>` for a scale-to-zero pool |

## Tests
- `packages/cli/src/deploy-verify-grade.test.ts` (unit): old→new mix restarts the window; 503 mid-window; each code from its tally; `--idle-ok` with depth 0 passes and depth 1 fails; a draining row and an old-build row serve nothing.
- `packages/cli/src/cmd-deploy-verify.test.ts` (unit, `Bun.serve` on loopback, frozen sleep): real header read; `x deploy --image` still runs the deploy, and `deploySpec.usage` names no `up`; no `DATABASE_URL` gives `graded: false` and never opens the embedded database.
- `packages/jobs/src/operator-surface.job.test.ts`: `build` round-trips through both drivers; a row announced without it reads absent.
- `bun test packages/cli/src/deploy-verify-grade.test.ts`

## Semver
**Breaking, one row.** New subcommand and optional member, but the column on `x_job_workers` changes every app's committed dump, so `drift` is red (`X_SCHEMA_DUMP_DRIFT`) until regenerated. `x deploy` unchanged.
Upgrading: "`x db gen`, commit `packages/db/schema/`."

## Done when
- A loopback server answering the old build then the new one passes only after `--window` of consecutive new answers.
- With no worker row for a registered queue, the command exits non-zero with `X_DEPLOY_QUEUE_UNSERVED` naming it.
- A worker row of the previous build does not serve a queue.
- `bun run verify` green.
