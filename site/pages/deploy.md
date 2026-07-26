---
title: Deploy
menu: true
nav: Deploy
description: One image, six roles selected by an env var, a graceful drain that redistributes sockets, and a deploy target defined as "runs containers".
lede: Build once; `ROLE` selects behavior. Zero platform primitives — if it needs a specific host, it isn't in the framework.
updated: 2026-07-26
---

## One image, N roles

```bash
docker build -t myapp .          # once
ROLE=web       myapp             # ← same image
ROLE=sync      myapp
ROLE=worker    myapp
ROLE=scheduler myapp
ROLE=migrate   myapp             # pre-deploy hook
ROLE=replicator myapp
```

| Role | Does | Scales on | Notes |
|---|---|---|---|
| `web` | SSR + static + RPC | **RPS** | behind CDN, stateless, N replicas |
| `sync` | live queries + fanout over WebSockets | **concurrent connections** | stateless, no sticky sessions |
| `worker` | jobs + steps | **queue depth** | one pool per named queue; `WORKER_QUEUES=default,integrations` |
| `scheduler` | cron dispatch → enqueue only | **fixed 1** | advisory-lock leader election; a second instance is a warm standby |
| `migrate` | run-once, pre-deploy | n/a | refuses to run if another version's migration is in flight (`X_MIGRATE_CONCURRENT`) |
| `replicator` | logical replication → change feed → matcher → NATS | **1 per database** | owns the replication slot; takes an advisory lock and exits if held |

No role holds durable state. A role that cannot get its lock exits non-zero with a typed error
rather than running degraded.

## Health endpoints

| Endpoint | Answers | Fails when | Consumer |
|---|---|---|---|
| `/healthz` | "is this process alive?" | event loop wedged, unhandled fatal state | liveness probe → restart |
| `/readyz` | "should traffic come here?" | DB unreachable, NATS down, migration version mismatch, **draining** | readiness probe → remove from rotation |

Both return `{ ok, role, buildId, checks: [...] }` — never a bare `200 OK` with no body.
`scheduler` standbys report not-ready by design.

## Graceful drain on SIGTERM

```text
SIGTERM
  1. /readyz → 503                    (LB stops sending new work; wait ≥ 2× probe interval)
  2. stop accepting new work          (HTTP: close listener; worker: stop claiming; sync: stop new subscribes)
  3. finish in-flight work            (bounded by DRAIN_TIMEOUT, default 30s)
  4. role-specific handoff            (see table)
  5. flush OTel spans + logs
  6. close pools, release advisory locks, exit 0
```

| Role | Step 4 handoff |
|---|---|
| `web` | in-flight requests and streaming responses finish; a stream past the deadline gets a typed truncation, not a socket reset |
| `sync` | send every client a `reconnect` frame with a per-client backoff delay, then close cleanly |
| `worker` | finish the current step, persist it, release the lease so another worker resumes at the next step — never mid-step |
| `scheduler` | release the leader lock so the standby promotes within one lock interval |
| `replicator` | flush the change feed to NATS up to the last confirmed LSN, then release the slot |

Closing 50,000 sockets at once means 50,000 simultaneous reconnects during a deploy, when
capacity is already reduced. So the drain is server-directed: each client gets a jittered
`afterMs` and a `resumeFrom` LSN, and the load balancer redistributes them because there is no
sticky session to honour.

## `x build`

```bash
x build --target docker     # one image, all roles (default)
x build --target binary     # single Bun-compiled executable, no runtime install
x build --target static     # site/ output only: HTML, assets, sitemap, feeds
```

| Target | Output | Use |
|---|---|---|
| `docker` | one OCI image, `ROLE` selects behavior | the normal path |
| `binary` | `dist/myapp` — `bun build --compile`, all roles inside | VMs, systemd, air-gapped |
| `static` | `dist/static/` — 0kb-JS pages, hashed assets, `sitemap.xml`, `robots.txt`, feeds | CDN / object storage |

All targets share one build ID (content hash), stamped into the image, the HTML, the assets,
`sw.js` and `x.manifest.json`. `x build` runs `x verify`'s static checks first — a build that
would fail `x verify` does not produce an artifact.

## Compose

```yaml
# docker/compose.prod.yml
x-app: &app
  image: myapp:${BUILD_ID}
  env_file: .env.prod
  restart: unless-stopped

services:
  migrate:    { <<: *app, environment: { ROLE: migrate },    restart: 'no' }
  web:        { <<: *app, environment: { ROLE: web },        deploy: { replicas: 3 },
                depends_on: { migrate: { condition: service_completed_successfully } } }
  sync:       { <<: *app, environment: { ROLE: sync },       deploy: { replicas: 2 } }
  worker:     { <<: *app, environment: { ROLE: worker, WORKER_QUEUES: 'default,integrations' },
                deploy: { replicas: 4 } }
  scheduler:  { <<: *app, environment: { ROLE: scheduler },  deploy: { replicas: 1 } }
  replicator: { <<: *app, environment: { ROLE: replicator }, deploy: { replicas: 1 } }
```

| Rule | Reason |
|---|---|
| `migrate` completes before `web`/`sync` start | a new schema must exist before new code reads it |
| `scheduler` and `replicator` at 1 replica | the leader lock makes a second one a standby, not throughput |
| `stop_grace_period` >= `DRAIN_TIMEOUT` | otherwise SIGKILL truncates the drain and the reconnect fanout |
| Health probes from `/readyz` | never a TCP check — a process can accept sockets while unable to serve |

## Kubernetes

Generated by `x build --target docker --helm`, one `Deployment` per role.

| Role | HPA metric | Notes |
|---|---|---|
| `web` | requests/sec (CPU as fallback) | behind Ingress + CDN; `terminationGracePeriodSeconds` >= drain |
| `sync` | **active WS connections** (custom metric) | no session affinity |
| `worker` | **queue depth** per named queue | one Deployment per queue when isolation matters |
| `scheduler` | none — `replicas: 1` | PDB maxUnavailable 1; the leader lock covers overlap |
| `replicator` | none — `replicas: 1` | StatefulSet-shaped for stable identity; owns the slot |
| `migrate` | n/a | pre-install/pre-upgrade `Job` hook; blocks the release on failure |

CPU autoscaling is wrong for `sync` and `worker`: a node holding idle sockets is near-zero CPU
and near-capacity, and a worker blocked on a slow HTTP call is idle CPU with a growing backlog.
Both metrics are exported as OTel metrics, so wiring an HPA is configuration, not instrumentation.

## The static path deploys independently

```bash
x build --target static && x deploy static --to <cdn>
```

| Property | Consequence |
|---|---|
| Static build excludes the app image | a copy change or a new blog post does not redeploy the API |
| Independent version, shared build-ID namespace | assets stay resolvable across N deploys |
| ISR pages regenerate server-side and push to the CDN | no full rebuild for one changed record |
| Rollback is a pointer swap | seconds, no container churn |
| Cache purge | tag-driven, one hop from the write |

## Targets

The only requirement: something that runs containers, plus Postgres. NATS and object storage
are optional in small deployments — Postgres covers queue and pubsub, a local volume covers files.

| Target | How |
|---|---|
| Hetzner + Compose | `compose.prod.yml` on one or two boxes |
| Fly.io | one app per role, or process groups |
| Railway / Render | one service per role, same image, `ROLE` per service |
| AWS ECS / Fargate | one task definition per role; ALB for `web`, NLB for `sync` |
| Any Kubernetes | the generated Helm chart — EKS, GKE, AKS, k3s |
| Bare VM | `--target binary` + systemd units per role |

Not supported, by design: vendor edge runtimes, serverless-function-per-route, vendor
KV/queue/cron primitives. Each would need a second implementation of a framework primitive, and
the second implementation is where behavior diverges.

## Release checklist

```bash
x verify                       # the gate — green means shippable
x build --target docker
ROLE=migrate <image>           # pre-deploy, must exit 0
<roll web + sync>              # drain-aware; clients reconnect with backoff
x build --target static        # independently, whenever copy changes
x status --json                # build-ID distribution of connected clients
```

Rollback is redeploying the previous image tag. The previous build's assets are still served
under the N-deploy retention window, so a rollback does not 404 anyone mid-session.
