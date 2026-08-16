# Tutorial 6 — growing up

**The app code is identical at every rung.** Climbing is an env var, a driver swap and someone else's infrastructure — never a rewrite. A small idea reaches a big output by changing where the rows and the messages live, not by changing what an `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route` or `task` says.

v1.1.0 `As of 2026-08`. The full ladder, with costs, seams and the places the invariant breaks, is [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md); running it for real is [`docs/ops/`](https://github.com/developerz-ai/ultimate/tree/main/docs/ops). This page is the decision procedure, not a second copy of either.

Series: [1 — first app](Tutorial-01-First-App) · [2 — first feature](Tutorial-02-First-Feature) · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · [5 — deploy free](Tutorial-05-Deploy-Free) · **6**

## Climb on a signal, never on a feeling

| Rung | You run | What forces the next rung | App code change |
|---|---|---|---|
| **0** — PaaS, one process | one web service, managed Postgres | a job that must not run in a request, or a cron that must fire on time | **none** |
| **1** — PaaS, roles split | one service per `ROLE`, managed Postgres, managed Redis-protocol cache | more than one `sync` replica, platform socket limits, or per-service pricing above a box | **none, plus config** |
| **2** — one box, Compose | one host: Postgres, cache, NATS, every role | one host is a single point of failure you can no longer accept, or cannot hold the load | **none, plus config** |
| **3** — Kubernetes | per-role Deployments and HPAs, JetStream fanout, logical replication | Postgres write throughput, a region you must serve from, a zone you must survive | **none, plus config** |
| **4** — distributed SQL | multi-AZ, YugabyteDB, metrics and traces wired end to end | nothing here is forced by scale — geography and availability targets force it | **none for the datastore swap** |

Skipping a rung to look serious buys a second product to maintain. A Kubernetes cluster running one app is that.

## What is allowed to change

| May change | Never changes |
|---|---|
| `DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `S3_ENDPOINT` | any file under `apps/` or `packages/` |
| `ROLE` — which process this container is | the eight primitives, their shapes, their authz |
| driver constructors at boot (`setJobDriver`, `setDbClient`, `configureTelemetry`) | call sites: `db()`, `ctx.jobs.enqueue()`, `query()`, `live()` |
| replica counts, HPA targets | the manifest, the OpenAPI, the typed client, the MCP tools |
| `app.config.ts` declarations | migrations already applied |

## Rung 0 → 1: split the roles

Same platform, same image. One service per `ROLE`. This is the rung a free tier's sleeping instance forces whether or not traffic did — see [tutorial 5](Tutorial-05-Deploy-Free#what-a-free-tier-costs-you).

| Role | Why it leaves the web service |
|---|---|
| `worker` | a job must survive the request that queued it and must not compete with it for CPU |
| `scheduler` | fixed at one, and **must be always-on** — a plan that sleeps it drops the cron |
| `migrate` | run-once, before anything serves the new schema |

`scheduler` leadership is a Postgres advisory lock, so a second instance is an idle standby rather than a duplicate. Its `/readyz` reports **not ready** by design.

### The shared cache tier

Add it when there is more than one web replica **and** a measured cross-replica miss. Not before.

```ts
// app.config.ts
cache: { driver: 'redis', tiers: ['memo', 'lru', 'shared'], urlEnv: 'REDIS_URL' },
```

Read order is memo → LRU → shared → origin, and a tier is never consulted for a request whose `policy` has not already passed. Adding one changes where a value is found, never how it is asked for.

> **Single-node Redis or Valkey only, `As of 2026-08`.** The tier-3 Lua invalidation script `DEL`s keys it never declared in `KEYS` — single-node Redis tolerates it, **Dragonfly and Redis Cluster reject it**, because a cluster cannot route a key it was not told about. On those, tag invalidation fails and entries live until their TTL. Use single-node Redis, or drop the shared tier.

Detail: [Caching and invalidation](Caching-And-Invalidation).

## Rung 1 → 2: one box, Compose

`docker/docker-compose.prod.yml` **is** the production topology — one service per role, one image, differing only by `ROLE`. `migrate` runs to completion and every serving role waits on `service_completed_successfully`.

```bash
bunx x deploy --image ghcr.io/you/myapp:1.2.3 --method compose
```

Start Postgres with `wal_level=logical`, `max_replication_slots=8` and `max_wal_senders=8` so the `replicator` role can preflight rather than fail on its first change.

> **The compose ceiling is one replica of each serving role, declared** `As of 2026-08`. The framework's file and the scaffolded one both publish a host port on `web` and `sync` and both set `replicas: 1` — one host port has exactly one binder. `worker` publishes no port and scales freely.
>
> Two ways past it: delete their `ports:` lines and put a reverse proxy of your own on the compose network, which the service names resolve across every replica; or take the next rung, where the chart's per-role HPA does it. The framework ships neither proxy — one in `docker-compose.prod.yml` is a dependency every app inherits and a second answer to "how does traffic reach a role" beside the chart's Ingress.

## Rung 2 → 3: Kubernetes

`x new` writes **no** Helm chart — a chart is a topology decision, not a scaffold default. `x deploy --method helm` on an app with no `docker/helm` exits `X_NOT_IMPLEMENTED` naming `--method compose`. Copy [`docker/helm`](https://github.com/developerz-ai/ultimate/tree/main/docker/helm) from the framework repo, or write the flat manifests in [`docs/ops/01-kubernetes.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/01-kubernetes.md). Carry one, never both — a repo with a chart *and* a manifest tree has two sources of truth for the same pod.

Three things turn on at this rung, all by env, none by a code path:

| Turn on | Set | Effect |
|---|---|---|
| cross-node fanout | `NATS_URL` | `selectTransport` builds `NatsTransport` instead of `InProcessTransport` |
| presence across nodes | `NATS_KV_BUCKET` (default `x_presence`) | presence becomes a JetStream KV bucket; its age limit and the presence TTL are one number |
| live queries off a real WAL | `REPLICATION_URL` · `REPLICATION_SLOT` · `REPLICATION_PUBLICATION` | `selectChangeFeed` builds `PgLogicalReplicationFeed`, under an advisory lock so exactly one replicator exists |

**Do not enable `replicator` until live queries are in use.** The chart ships it `enabled: false` for that reason.

Per-role HPAs target `rps`, `connections` and `queue_depth` — CPU is a lagging proxy for all three serving roles. Every role serves `/metrics` on `METRICS_PORT` (default 9090) and `http`/`realtime`/`jobs` emit the series. The chart still cannot scrape them: no role declares a metrics container port and no scrape target ships, so an HPA sits at `<unknown>` until you add both plus a custom metrics adapter.

## Rung 3 → 4: three separable moves

| Move | The only good reasons | The bad reason |
|---|---|---|
| dedicated servers over cloud instances | steady predictable load; egress cost; hardware sized to the working set | "cloud is expensive", with no bill that says so |
| custom Kubernetes over a managed chart | node pools with real taints, affinity to node-local storage, an ingress you control | wanting the chart to look impressive |
| distributed SQL over one Postgres | multi-region **write** locality; surviving a zone loss with no manual failover | write throughput one Postgres has not actually failed to deliver |

Observability is the part that is not optional here and the part the framework does least of: tracing is a seam with a no-op default exporter and **no OTLP exporter ships**. Wire it yourself. [`docs/ops/03-observability.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/03-observability.md) says what to scrape and what is missing.

## The seams, so nothing surprises you

| Concern | Interface | Decided by |
|---|---|---|
| rows | `@ultimat3/db` · `DbClient` | `DATABASE_URL` — unset is PGlite, and PGlite is `x dev` only |
| job queue | `@ultimat3/jobs` · `JobDriver` | `jobs.driver: 'postgres'`. Redis and NATS drivers are interface-complete stubs that throw `X_NOT_IMPLEMENTED` — v2 |
| realtime fanout | `@ultimat3/realtime` · `Transport` | `NATS_URL` |
| change feed | `@ultimat3/realtime` · `ChangeFeed` | `REPLICATION_*` |
| cache | `@ultimat3/cache` · `CacheTier` | `cache.tiers` + `REDIS_URL` |
| object storage | `@ultimat3/storage` · `Driver` | `S3_ENDPOINT` |
| mail | `@ultimat3/mail` · `Driver` | mail env |
| tracing | `@ultimat3/core` · `SpanExporter` | `configureTelemetry()` — default no-op |

Every one keys on env or a boot-time constructor. One image resolves `x dev`, a Compose host and a cluster identically.

## Rehearse the climb before you need it

| Step | Command |
|---|---|
| point the app at a real Postgres | `DATABASE_URL=… ROLE=migrate bun apps/web/server.ts`, then `ROLE=web` |
| prove the plan without running it | `bunx x deploy --image … --dry-run --json` |
| prove the image before the platform does | `docker run -e ROLE=web -e PORT=8080 -p 8085:8080 …` and poll `/readyz` |
| prove the gate still holds | `bunx x verify` — the same 17 steps, at every rung |

## Where the invariant genuinely breaks

Named rather than left to be discovered:

| Break | Rung |
|---|---|
| tier-3 cache invalidation on Dragonfly / Redis Cluster | 1 |
| one replica per role under the shipped compose file | 2 |
| no Helm chart in a scaffolded app | 3 |
| no OTLP exporter; `/metrics` not on `ROLE=web`; `x logs` planned | 3–4 |
| Redis and NATS **job** drivers throw `X_NOT_IMPLEMENTED` | any |
| realtime tier 3 (local-first, `persist: true`), the plugin API, multi-region replication | v2 |

Each sits behind an interface that ships today and fails loudly, rather than pretending to work. The full list, with a workaround per row: [Known gaps](Known-Gaps).

## Read next

| Doc | Answers |
|---|---|
| [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md) | the full rung table, costs, the seam table, YugabyteDB honestly |
| [`docs/ops/`](https://github.com/developerz-ai/ultimate/tree/main/docs/ops) | Kubernetes manifests, secrets, observability, datastore sizing, disaster recovery, runbooks |
| [Deployment](Deployment) | roles, health endpoints, the drain contract, build targets |
| [Configuration](Configuration) | every `app.config.ts` field and every env var |
| [Upgrading](Upgrading) | moving every `@ultimat3/*` in lockstep |

Related: [Caching and invalidation](Caching-And-Invalidation) · [Realtime](Realtime) · [Jobs and workflows](Jobs-And-Workflows) · [Troubleshooting](Troubleshooting)
