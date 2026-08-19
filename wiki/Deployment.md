# Deployment

One image, N roles. Build once; the `ROLE` env var selects behavior. No role-specific Dockerfile, no per-role dependency set, no drift between what you tested and what runs.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). All three build targets ship — `x build --target docker`, `x build --target binary`, `x build --target static` — and so do the compose files and the Helm chart. Milestone 11 is 🚧 on one thing ([roadmap](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md)): the two-platform proof — the demo app on Compose **and** on K8s from one image, with a rolling restart invisible to connected clients.

```
docker build -t myapp .          # once
ROLE=web       myapp             # ← same image
ROLE=sync      myapp
ROLE=worker    myapp
ROLE=scheduler myapp
ROLE=migrate   myapp             # pre-deploy hook
ROLE=replicator myapp
```

## Roles

| Role | Does | Scales on | Notes |
|---|---|---|---|
| `web` | SSR + static + RPC (actions/queries over HTTP) | **RPS** | behind CDN, stateless, N replicas, no local state |
| `sync` | live queries + fanout over WebSockets | **concurrent connections** | stateless, **no sticky sessions** — a client may reconnect to any node |
| `worker` | jobs + steps | **queue depth** | one pool per named queue; `WORKER_QUEUES=default,integrations` |
| `scheduler` | cron dispatch → enqueue only | **fixed 1** | Postgres advisory-lock leader election; a second instance is a warm standby, not a duplicate |
| `migrate` | run-once, pre-deploy | n/a | applies migrations through the ledger and **exits**; never binds a port. Holds the migration advisory lock on one pinned session for the whole run, so overlapping deploys serialise — the second waits, polling once per 500ms for up to 60s, then exits non-zero with `X_MIGRATE_CONCURRENT` rather than hanging the rollout (`As of 2026-08`; 1.2.0 waits forever — [Known gaps](Known-Gaps)) |
| `replicator` | logical replication → change feed → matcher → NATS | **1 per database** | owns the replication slot; a second instance would double-deliver, so it takes an advisory lock and exits if held |

- No role holds durable state. Everything survivable is in Postgres, NATS, or object storage.
- A role that cannot get its lock **exits non-zero with a typed error** rather than running degraded.
- **There is no `ROLE=all`.** Those six names are the whole set; anything else is `X_ROLE_UNKNOWN` at boot. For dev, `x dev` co-locates `web`, `sync`, `worker` and `scheduler` in one process — role isolation is simulated, not skipped, and `--role` opts the `replicator` in.

`PORT` selects the bind port, default `3000`. Empty or whitespace falls back to the default; anything else must be an integer in 0–65535 or the process refuses with `X_PORT_INVALID` rather than quietly binding 3000 and failing the platform's health probe with nothing in the log that names the cause. The production entry is the scaffolded `apps/web/server.ts` → [CLI reference](CLI-Reference).

## Health endpoints

Every role exposes both, on every replica. Both return `{ ok, role, buildId, checks: [...] }` — never a bare `200 OK` with no body.

| Endpoint | Answers | Fails when | Consumer |
|---|---|---|---|
| `/healthz` | "is this process alive?" | event loop wedged, unhandled fatal state | liveness probe → restart |
| `/readyz` | "should traffic come here?" | DB unreachable, NATS down, migration version mismatch, **draining** | readiness probe → remove from rotation |

| Role | `/readyz` additionally checks |
|---|---|
| `web` | DB pool healthy, build ID matches the migration version |
| `sync` | replication feed lag under threshold, NATS subscribed |
| `worker` | queue reachable, at least one pool claiming |
| `scheduler` | holds the leader lock (a standby reports not-ready, by design) |
| `replicator` | slot active, WAL lag under threshold |

## Graceful drain on SIGTERM

Identical in every role. Framework behavior, not a deployment guide.

```
SIGTERM
  1. /readyz → 503                    (LB stops sending new work; wait ≥ 2× probe interval)
  2. stop accepting new work          (HTTP: close listener; worker: stop claiming; sync: refuse new upgrades)
  3. finish in-flight work            (bounded by DRAIN_TIMEOUT, default 30s)
  4. role-specific handoff            (see table)
  5. flush OTel spans + logs
  6. close pools, release advisory locks, exit 0
```

| Role | Step 4 handoff |
|---|---|
| `web` | let in-flight requests and streaming responses finish; a stream past the deadline gets a typed truncation, not a socket reset |
| `sync` | send every client a `reconnect` frame **with a per-client backoff delay** (see below), then close cleanly |
| `worker` | finish the current step, persist it, and release the job's lease so another worker resumes at the next step — never mid-step |
| `scheduler` | release the leader lock immediately so the standby promotes within one lock interval |
| `replicator` | flush the change feed to NATS up to the last confirmed LSN, then release the slot |

Exceeding `DRAIN_TIMEOUT` throws `X_SHUTDOWN_TIMEOUT`; requests arriving during the drain get `X_DRAINING`.

### Why `sync` sends server-directed jittered reconnect

Closing 50,000 sockets at once means 50,000 simultaneous reconnects, all resubscribing, all asking "what changed since my LSN?" — a self-inflicted DDoS landing during a deploy when capacity is already reduced, and it is fractal: surviving nodes overload, drop connections, and the herd re-forms.

```
{ type: 'reconnect', afterMs: 1830, resumeFrom: '0/1A2B3C4', reason: 'drain' }
```

| Property | Effect |
|---|---|
| Per-client `afterMs`, jittered over a window | reconnects arrive spread out, not as a spike |
| Server chooses the window from live connection count | 500 clients drain in a second; 500k spread over minutes |
| `resumeFrom` LSN | reconnect is a **delta from the change buffer**, not a resubscribe-and-refetch |
| Clients redistribute | the LB places them across remaining nodes; no sticky session to honour |
| Client-side backoff is a floor, not the mechanism | a client that loses the socket without a frame still backs off exponentially with jitter |

**`sync` takes both shutdown phases, and they answer different questions** `As of 2026-08`. The `accept` phase calls `stopAccepting()`: `/readyz` flips to 503 and an upgrade arriving anyway is shed with `retry-after-ms`, while every socket the node already holds keeps its patch stream — sockets are untouched and no `reconnect` frame has been sent yet. The `close` phase is the drain below, then `stop()`. Registered with no phase, the whole thing landed in `close`, and until that last phase ran the node went on upgrading new websockets onto a process that was going away.

There is no `realtime.drain` config key — the spread window is `createSyncNode({ drainSpreadMs })`, default 30s, and the grace is `drain({ graceMs })`, default 5s ([Configuration](Configuration)). The reconnect benchmark that gated topology now exists: 50,000 sockets, a `SIGKILL`ed `sync` node with **no** drain and no `reconnect` frame — all 50,000 reconnected on their own backoff, 49,981 received a channel patch inside the window at p50 54.0s / p90 105.5s, 156,851 connect attempts shed before any query path. That is time to the first patch on the reconnected socket — reachability, not consistency — and it is the floor this section's frame is meant to beat. Measured on **one** node ([Realtime](Realtime)).

## `x build`

```
x build --target docker     # one image, all roles (default)
x build --target binary     # single Bun-compiled executable, no runtime install
x build --target static     # site/ output only: HTML, assets, sitemap, feeds
```

| Target | Output | Use |
|---|---|---|
| `docker` | one OCI image, `ROLE` selects behavior | the normal path |
| `binary` | `.x/app` — `bun build --compile`, all roles inside. Boots `As of 2026-08`; **not yet served from a bare VM** ([Known gaps](Known-Gaps)) | VMs, systemd, air-gapped, a CLI-shaped product |
| `static` | `.x/static` — 0kb-JS pages, hashed assets, `sitemap.xml`, `robots.txt`, feeds | CDN / object storage, deployed independently |

All targets share one build ID (content hash), stamped into the image, the HTML, the assets, `sw.js`, and `x.manifest.json`.

```
$ x build --target docker
  ✓ typecheck + boundaries           ✓ site/  12 routes  static   0kb js
  ✓ app/   31 routes  stream         ✓ static assets     avif+webp, 214 files
  ✓ sw.js  precache 1.9MB / 3MB      ✓ manifest + openapi emitted
  ✓ image  myapp:8f2a1c9  118MB      build id 8f2a1c9
```

`x build` runs six of `x verify`'s steps first — `typecheck`, `lint`, `boundaries`, `filesize`, `package-shape`, `errors` — and produces no artifact if any fail. It also refuses before spawning the builder when the target's entry file is missing (`X_BUILD_ENTRY_MISSING`) → [CLI reference](CLI-Reference).

## Dev compose

```yaml
# docker/docker-compose.dev.yml — only needed for parity checks; `x dev` needs none of this
services:
  app:      { build: ., environment: { ROLE: web }, ports: ['3000:3000'] }
  postgres: { image: postgres:17, ports: ['5432:5432'] }
  nats:     { image: nats:2, command: '-js', ports: ['4222:4222'] }
  minio:    { image: minio/minio, command: 'server /data', ports: ['9000:9000'] }
```

`x dev` uses embedded Postgres, in-process NATS, and a local directory for S3 — **Docker is not required to develop.** This file exists for parity debugging and CI jobs that want real services.

## Prod compose

```yaml
# docker/docker-compose.prod.yml
x-app: &app
  image: myapp:${BUILD_ID}
  env_file: .env.prod
  restart: unless-stopped

services:
  migrate:    { <<: *app, environment: { ROLE: migrate },    restart: 'no' }
  web:        { <<: *app, environment: { ROLE: web, PORT: 3000 }, ports: ['3000:3000'],
                deploy: { replicas: 1 },
                depends_on: { migrate: { condition: service_completed_successfully } } }
  # PORT is the WEB port even here: `sync` binds PORT + 1, so 3000 is a listener on 3001.
  sync:       { <<: *app, environment: { ROLE: sync, PORT: 3000 }, ports: ['3001:3001'],
                deploy: { replicas: 1 } }
  worker:     { <<: *app, environment: { ROLE: worker, WORKER_QUEUES: 'default,integrations' },
                deploy: { replicas: 4 } }
  scheduler:  { <<: *app, environment: { ROLE: scheduler },  deploy: { replicas: 1 } }
  replicator: { <<: *app, environment: { ROLE: replicator }, deploy: { replicas: 1 } }
```

| Rule | Reason |
|---|---|
| `migrate` completes before `web`/`sync` start | a new schema must exist before new code reads it |
| `web` and `sync` at 1 replica | each publishes a host port, and a host port has exactly one binder |
| `PORT: 3000` on `sync`, published as `3001:3001` | the `sync` role binds `PORT + 1`; naming 3001 opens 3002 and publishes a socket nothing in the container ever opened |
| `scheduler` and `replicator` at 1 replica | leader lock makes a second one a standby, not throughput |
| `stop_grace_period` >= `DRAIN_TIMEOUT` | otherwise SIGKILL truncates the drain and the reconnect fanout |
| Health probes from `/readyz` | never from a TCP check — a process can accept sockets while unable to serve |

`x deploy --method compose` applies this against the committed `docker/docker-compose.prod.yml`; it is a plain compose file you can read, diff, and run by hand.

> **`web` and `sync` are one replica each, and the file says so** `As of 2026-08`. Both publish a host port, one host port has exactly one binder, so both declare `replicas: 1` — a ceiling that is declared rather than discovered when the second container dies on `port is already allocated`. `worker`, `scheduler` and `replicator` publish nothing; `worker` scales freely.
>
> | Want | Do |
> |---|---|
> | more `web`/`sync` on the same box | delete their `ports:` lines, add a reverse proxy of your choosing to the compose file, point it at the service names — compose DNS resolves each to every replica |
> | more `web`/`sync`, full stop | the Helm chart below, which carries a per-role HPA and an Ingress |
>
> The framework ships neither proxy: a proxy image in `docker-compose.prod.yml` is a dependency every app inherits and a second answer to "how does traffic reach a role" beside the chart's Ingress. This is the rung-1 ceiling → [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md).

## Helm

Committed at `docker/helm` in the framework repo, one `Deployment` per role. Nothing generates it — there is no `--helm` flag on `x build`.

| Role | HPA metric | Typical range | Notes |
|---|---|---|---|
| `web` | requests/sec (or CPU as fallback) | 3–50 | behind Ingress + CDN; `terminationGracePeriodSeconds` >= drain |
| `sync` | **active WS connections** (custom metric) | 2–100 | no session affinity; connection count is the only honest signal |
| `worker` | **queue depth** per named queue (custom metric) | 2–200 | one Deployment per queue when isolation matters |
| `scheduler` | none — `replicas: 1` | 1 | `PodDisruptionBudget` maxUnavailable 1, leader lock covers overlap |
| `replicator` | none — `replicas: 1` | 1 | `StatefulSet`-shaped for stable identity; owns the slot |
| `migrate` | n/a | — | pre-install/pre-upgrade `Job` hook; blocks the release on failure |

CPU autoscaling is wrong for `sync` and `worker`: a node holding 80k idle sockets is near-zero CPU and near-capacity, and a worker blocked on a slow HTTP call is idle CPU with a growing backlog. The framework **declares** both series — `connections` and `queue_depth`, with `rps` derived from the monotonic `http_requests_total` — and `SCALING_METRICS` maps each role's signal to its series so the chart and the role table cannot drift. `As of 2026-08` every role serves `/metrics` on `METRICS_PORT` (default 9090) and `http`/`realtime`/`jobs` call the recorders, so the signals exist. **The chart's half is closed in 2.0.0**: `values.yaml` declares `metricsPort: 9090`, `_helpers.tpl` emits a container port named `metrics` on every role but `migrate`, `service.yaml` publishes it by name and `templates/servicemonitor.yaml` ships the scrape target. Two things remain, and neither is the chart's: `serviceMonitor.enabled` defaults **false**, because a cluster without the Prometheus operator has no such CRD and `helm install` would fail on an unknown kind; and turning scraped series into the `Pods` metrics an HPA reads needs a **custom-metrics adapter**. Do not hand-add a metrics container port — the chart already emits one and a duplicate is rejected by the API server → [Observability](Observability).

The chart is committed at `docker/helm` in the framework repo and **is not part of the scaffold**, which is why `x deploy --method helm` throws `X_NOT_IMPLEMENTED` in a fresh app. Copy it in, or deploy with `--method compose`.

## Static deploys independently

```
x build --target static        # dist in .x/static — upload it with your CDN's own tool
```

| Property | Consequence |
|---|---|
| Static build does not include the app image | a copy change, a new blog post, a pricing tweak **does not redeploy the API** |
| Independent version, shared build ID namespace | assets stay resolvable across N deploys ([PWA and offline](PWA-And-Offline)) |
| ISR pages regenerate server-side and push to the CDN | no full rebuild for one changed record |
| Rollback is a pointer swap | seconds, no container churn |
| Cache purge | tag-driven, one hop from the write ([Caching and invalidation](Caching-And-Invalidation)) |

## Targets

The only requirement: **something that runs containers, plus Postgres.** NATS and object storage are optional in small deployments — Postgres covers queue and pubsub; a local volume covers files.

| Target | How | Notes |
|---|---|---|
| Hetzner + Compose | `compose.prod.yml` on one or two boxes | cheapest credible production; one node runs all roles |
| Fly.io | one app per role, or process groups | drain semantics map cleanly to Fly's SIGTERM handling |
| Railway / Render | one service per role, same image | set `ROLE` per service |
| AWS ECS / Fargate | one task definition per role | ALB for `web`, NLB for `sync` |
| Any Kubernetes | the generated Helm chart | EKS, GKE, AKS, k3s — no cloud-specific resources |
| Bare VM | `--target binary` + systemd units per role | no container runtime at all |

Not supported, **by design**: vendor edge runtimes, serverless-function-per-route, vendor KV / queue / cron primitives, proprietary image loaders. Each would need a second implementation of a framework primitive, and the second implementation is where behavior diverges.

## Release checklist

```
x verify                       # the gate — green means shippable
x build --target docker
ROLE=migrate <image>           # pre-deploy, must exit 0
<roll web + sync>              # drain-aware; clients reconnect with backoff
x build --target static        # independently, whenever copy changes
x doctor --json                # env, versions, drift, ports
```

## Running it for real — `docs/ops/`

The framework depends on none of this; it is the operations manual for the app you deploy with it. **Recommendations, not contracts** — nothing in `packages/` reads a word of it.

| Doc | Answers |
|---|---|
| [`docs/ops/README.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/README.md) | the PaaS → Compose → Kubernetes ladder, and which rung you are on |
| [`docs/ops/01-kubernetes.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/01-kubernetes.md) | the chart, one Deployment per role, probes, PDBs, HPAs |
| [`docs/ops/02-secrets.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/02-secrets.md) | env or a mounted file, and nothing vendor-shaped |
| [`docs/ops/03-observability.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/03-observability.md) | what to scrape, what to alert on, what is not implemented yet → [Observability](Observability) |
| [`docs/ops/04-datastores.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/04-datastores.md) | sizing Postgres, NATS and object storage for a given rung |
| [`docs/ops/05-disaster-recovery.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/05-disaster-recovery.md) | backups, PITR, restore drills, replication-slot recovery |
| [`docs/ops/06-runbooks.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/06-runbooks.md) | symptom → page → action, per role |

Two design-only companions — **specification, not shipped behaviour**: [`docs/idea/16-app-targets.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/16-app-targets.md) (three targets, one backend, two view layers) and [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md) (why the app code is identical at rung 0 and rung 4).

## Rollback

Redeploy the previous image tag. Previous builds' assets stay served under the N-deploy retention window (default 10 deploys or 7d, whichever is longer), so a rollback does not 404 anyone mid-session. Version-skew handling: [Upgrading](Upgrading). Failure symptoms: [Troubleshooting](Troubleshooting).
