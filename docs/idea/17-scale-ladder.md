# Scale ladder

**The app code is identical at rung 0 and rung 4.** Climbing is a driver swap, an env var and someone else's infrastructure — never a rewrite. A small idea reaches a big output by changing where the rows and the messages live, not by changing what an `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route` or `task` says.

**Rung 0 is free**, not merely cheap: a free or hobby PaaS instance and a free managed Postgres, no credit card, no ops. That is the entry point the whole ladder is arranged around — the framework is the thing that is already ready when the app grows, so growing costs configuration instead of a rewrite ([`00-thesis.md`](./00-thesis.md#pre-mvp-to-planet-scale-without-a-rewrite)).

Each rung below states what you run, what forces the next one, and what the app code change is. The **App code change** column is the claim under test: where the invariant does not hold today, it is named as a break, not softened.

## What may change on the way up

| May change | Never changes |
|---|---|
| `DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `S3_ENDPOINT` | any file under `apps/` or `packages/` in the app |
| `ROLE` — which process this container is | the eight primitives, their shapes, their authz |
| driver constructors at boot (`setJobDriver`, `setDbClient`, `configureTelemetry`) | call sites: `db()`, `ctx.jobs.enqueue()`, `query()`, `live()` |
| replica counts, node counts, HPA targets | the manifest, the OpenAPI, the typed client, the MCP tools |
| `app.config.ts` declarations | migrations already applied |

## The rungs

| Rung | You run | Rough footprint `As of 2026-08` | What breaks to force the next rung | App code change |
|---|---|---|---|---|
| **0 — PaaS, one process, free tier** | Render / Railway / Fly / Heroku: one web service on a free or hobby plan, their free managed Postgres | 1 × 512MB instance + a free PG. **$0**, rising to tens of $/mo when the free plan's caps bite | the instance sleeps and you need a `scheduler` or `worker` that cannot; or the free Postgres connection cap; or a free database that expires | **none** — but a sleeping instance cannot host every role, see below |
| **1 — PaaS, roles split, shared cache** | same platform, one service per `ROLE`, managed Postgres, managed Redis-protocol cache | 2–4 small instances + PG + 256MB–1GB cache. Low hundreds of $/mo | >1 `sync` replica needed, or the platform's networking/socket limits bite, or per-service pricing exceeds a box | **none, plus config** — `ROLE` per service, `cache.tiers` gains `shared`, `REDIS_URL` set |
| **2 — one box, Compose, every role** | a single 6-vCPU / 12-GiB server: Postgres, a Redis-protocol cache, NATS, all six roles | 1 dedicated/VPS host. Tens of $/mo, plus backups | one host is a single point of failure you can no longer accept, or one host cannot hold the load | **none, plus config** — `docker-compose.prod.yml`, `NATS_URL` set |
| **3 — Kubernetes, replicated roles** | k8s, per-role Deployments + HPAs, NATS JetStream for fanout and presence, a shared cache tier, Postgres with logical replication for the change feed | 3 control + 2–3 workers, one DB-tainted node. Hundreds of $/mo | Postgres write throughput, a region you must serve from, or a zone failure you must survive | **none, plus config** — Helm values, `REPLICATION_*` set, `replicator` role enabled |
| **4 — distributed SQL and real observability** | dedicated hardware or multi-AZ cloud, distributed SQL (YugabyteDB), JetStream R3, metrics/traces/alerts wired end to end | ≥3 DB nodes at 4–8 vCPU each, on top of rung 3 | nothing here is forced by scale — it is forced by geography, availability targets, or a single Postgres you have genuinely outgrown | **none for the datastore swap** — but see [YugabyteDB, honestly](#yugabytedb-honestly) and [Where the invariant breaks today](#where-the-invariant-breaks-today) |

Costs are order-of-magnitude, not quotes. No price in this table is verified against a vendor bill.

---

## Rung 0 — a free PaaS plan, not a container you operate

The bottom rung is `git push` on a plan that costs nothing. No Kubernetes, no Compose, no ops, no card.

| Concern | What the framework already does |
|---|---|
| Port | `packages/http/src/config.ts` reads `env('PORT')`, default 3000 — a platform-assigned port works with no change |
| Health | `web` and `sync` serve `/healthz` and `/readyz` from `packages/http/src/server.ts`; `/readyz` flips to 503 on SIGTERM before the socket closes. They are the only roles that construct a server — `worker`, `scheduler` and `replicator` open only the metrics listener, which is exactly what rung 0 runs one of |
| Release-phase migrations | `ROLE=migrate` runs to completion and exits ([`packages/cli/src/serve.ts`](../../packages/cli/src/serve.ts)); map it to Heroku's release phase or Render's pre-deploy command |
| Drain | SIGTERM drain is framework behaviour, not a deployment guide ([`11-topology.md`](./11-topology.md)) |
| Image | Heroku and Render both accept a `Dockerfile`; `x new` writes one at `docker/Dockerfile`, entrypoint `bun apps/web/server.ts` |
| Which deploy this is | `resolveEnvironment()` reads `ULTIMATE_ENV` → `development \| test \| staging \| production`, the twin of `ROLE`. One variable, not a second convention per platform |
| Secrets | env keys only. `app.config.ts` names `urlEnv`, never a value — one image, every environment. A value typed `Secret` redacts itself in `toString`, `toJSON` and the logger at any depth, so a free-tier log drain is not where the DSN leaks |

**Unblocked since 1.1.0.** A scaffolded app now produces a deployable artifact: `x new` writes `apps/web/server.ts` (three lines calling `runRole`), `apps/web/prerender.ts`, `docker/Dockerfile`, its `.dockerignore` and `docker/docker-compose.prod.yml` ([`templates/scaffold-app.ts`](../../packages/cli/src/templates/scaffold-app.ts), [`templates/scaffold-container.ts`](../../packages/cli/src/templates/scaffold-container.ts)), and the Dockerfile has no build stage at all — `x verify` is the gate, so the image never needs the devDependencies its `--production` install leaves out.

All three targets compile. `docker` and `binary` produce artifacts that start; `static` starts nothing — it emits files for a CDN or an object store. `--target binary` did not start until the framework's version read went lazy and `x build` began compiling it in as `--define ULTIMATE_FRAMEWORK_VERSION="<version>"` — a single-file executable carries no `package.json`. Rung 0 does not need the binary; the bare-VM row in [`12-build-deploy.md`](./12-build-deploy.md) does, and that row stays **unproven** until a scaffolded app is compiled and served from a VM.

### What a free tier actually constrains

The framework does not hide these, and three of them touch a seam it owns. `As of 2026-08`:

| Free-tier constraint | What it hits | Answer today |
|---|---|---|
| **The instance sleeps** when idle and cold-starts on the next request | `web` tolerates it — a cold start is a slow first request. `scheduler` and `worker` **do not**: a cron that fires while the process is asleep does not fire, and a sleeping worker claims nothing | **Stated plainly: a free single-service deploy cannot run the `scheduler` role.** A durable job still runs — the queue is Postgres, so work waits — but it waits until something wakes the instance. Cron on a free tier needs either a paid always-on service or an external pinger, and neither is the framework's to supply ([axiom 7](./00-thesis.md)) |
| **Low connection cap** on free Postgres, often 20 or fewer | `POOL_PROFILES` defaults `web` to `max: 20` ([`packages/db/src/client.ts`](../../packages/db/src/client.ts)), which alone can consume the whole cap and starve the `migrate` release step | Override the profile at `createPostgresClient({ profile })`, or set `DATABASE_POOL_MAX` — the one pool knob an operator reaches without a rebuild (`POOL_MAX_ENV`, layered over the role profile by `baseClient()`). **There is no `database.poolSize`**: 4.0.0 deleted it, validated and read by nothing, and [break 4](#where-the-invariant-breaks-today) is the gate that now refuses a key like it |
| **Ephemeral filesystem** — the disk is gone on every restart | `@ultimat3/storage`'s `driver-local` writes under a directory; PGlite, if `DATABASE_URL` is unset, does the same | The storage seam is the point: set `S3_ENDPOINT` and `S3_*` for `driver-s3` and nothing in the app changes. Never ship a free tier with the local driver holding user uploads, and always set `DATABASE_URL` |
| **Memory ceiling**, typically 512MB | one process running every role at once | Rung 0 is one `web` service. Live queries at any size want their own process — that is rung 1, and the reason the ladder exists |
| **A free database that expires** after a fixed window on some platforms | everything | A migration ledger and `x db` are the same on a paid instance; changing `DATABASE_URL` is the whole migration |

**When rung 0 is enough:** almost always, for longer than feels right. One process, one managed Postgres, `cache.tiers: ['request-memo', 'lru']`, `realtime.transport: 'memory'` — the `x new` defaults — serve a real product with real users, and every one of those defaults is what an unset variable already means.

## Rung 1 — one service per role, one shared cache

Same platform. The change is `ROLE` and two env vars. This is also the rung a free tier's sleeping instance forces, whether or not traffic did.

| Role | Why it leaves the web service |
|---|---|
| `worker` | a job that must survive the request that queued it, and must not compete with it for CPU |
| `scheduler` | cron dispatch, fixed at one — leader election is an expiring lease row, so a second instance is an idle standby. **Must be always-on**: a plan that sleeps it drops the cron |
| `migrate` | run-once, before anything serves the new schema |

Add the shared cache tier when there is more than one web replica **and** a measured cross-replica miss. `cache.tiers: ['request-memo', 'lru', 'redis']` plus `REDIS_URL`. Redis, Valkey or Dragonfly `As of 2026-08` — the key layout is slot-clean, so no engine is excluded and no server flag is needed ([below](#dragonfly-honestly)).

**App code change: none.** The cache tiers are read-through and ordered by `TIER_ORDER`; adding one changes where a value is found, never how it is asked for ([`packages/cache/src/tiers.ts`](../../packages/cache/src/tiers.ts)).

## Rung 2 — one box, every role, Compose

`docker/docker-compose.prod.yml` **is** the production topology: one service per role, one image, scale a role by scaling its service. Postgres started with `wal_level=logical`, `max_replication_slots=8`, `max_wal_senders=8` so the `replicator` role can preflight successfully instead of failing on its first change.

An operator running this stack in production sizes one 6-vCPU / 12-GiB host to hold Postgres (4 GiB request, 6 GiB limit, `shared_buffers` 3 GB, `max_connections` 450), three cache instances and a pooler — `As of 2026-08`. That is the shape of a rung-2 box.

**`x new` ships this file now** — `docker/docker-compose.prod.yml`, alongside `docker/Dockerfile` and its `.dockerignore`. `docker/helm/` still lives only in the framework repo and must be copied to reach rung 3.

**The compose ceiling is one replica per role for anything that publishes a host port**, and every shipped file declares it rather than violating it, `As of 2026-08` — one host port has exactly one binder. Scale a role on this rung by putting a proxy on the network and deleting the `ports:` line; raising the number is how you get a replica that never starts ([`12-build-deploy.md`](./12-build-deploy.md)). The portless roles — `worker`, `scheduler`, `replicator` — scale here freely, which is why `worker` is the knob this rung actually has.

**App code change: none, plus config.**

## Rung 3 — Kubernetes, NATS, the change feed

The chart is per-role Deployments with per-role HPAs, because CPU is a lagging proxy for all three serving roles: `web` on RPS, `sync` on connections per pod, `worker` on queue depth ([`docker/helm/values.yaml`](../../docker/helm/values.yaml)).

What actually turns on at this rung:

| Turn on | By setting | Effect |
|---|---|---|
| cross-node fanout | `NATS_URL` | `selectTransport` builds a `NatsTransport` instead of `InProcessTransport` |
| presence across nodes | `NATS_KV_BUCKET` (default `x_presence`) | presence is a JetStream KV bucket; its age limit and the presence TTL are one number |
| live queries off a real WAL | `REPLICATION_URL` / `REPLICATION_SLOT` / `REPLICATION_PUBLICATION` | `selectChangeFeed` builds `PgLogicalReplicationFeed` instead of `InMemoryChangeFeed`, and takes `pg_try_advisory_lock(hashtext('x:replicator:<slot>'))` so exactly one replicator exists |

**App code change: none.** Both selectors key on env, never on a code path — one image resolves `x dev`, a Compose host and a cluster identically.

**Do not run `replicator` until live queries are in use.** The chart ships it `enabled: false` for exactly that reason.

**The 50k number is per-node, not per-cluster.** `scripts/bench/restart-bench.ts` boots one `sync` node over `InProcessTransport` and SIGKILLs it. 50,000 clients: all 50,000 reconnected, 49,981 had received a channel patch inside the window; time to that first patch on the reconnected socket p50 54.0s / p90 105.5s; 156,851 connect attempts shed by the `AcceptBudget` before reaching any query path. Recovery is bounded by admission control at its 500/s default, not by the matcher. Multi-node fanout over NATS is *not* what that benchmark measured.

**Reachability, not consistency** — the metric was published as "time-to-consistent" until 2026-08 and could not see a lost patch: a channel topic has no cursor and no re-snapshot, so the timer that stops on the first patch cannot notice a second one that never arrived. The timings are unchanged. Loss is the second run's question: 10,000 clients, a probe every 200ms, **1,666,882 patches received, 0 observed sequence gaps** ([`scripts/bench/results/10k-restart-seq.json`](../../scripts/bench/results/10k-restart-seq.json)), `As of 2026-08` the only run with delivery accounting, and not evidence about 50,000. That zero is a **lower bound on loss**: a gap needs a received frame on each side of it, so anything lost before a connection's first arrival or after its last is uncounted, as is a connection that received nothing at all. The defensible sentence is "no client observed a lost frame" — writing "0 lost" restates a bounded measurement as an absolute, which is the same error "time-to-consistent" made.

## Rung 4 — dedicated hardware, distributed SQL, observability

Three separable moves. Take them one at a time and only for a stated reason.

| Move | The only good reasons | The bad reason |
|---|---|---|
| dedicated servers instead of cloud instances | steady, predictable load; egress cost; hardware you can size to the working set | "cloud is expensive" without a bill that says so |
| custom Kubernetes instead of a managed chart | node pools with real taints (a DB-dedicated node), affinity to node-local storage, an ingress you control | wanting the chart to look impressive |
| distributed SQL instead of one Postgres | multi-region **write** locality; surviving a zone loss without a manual failover | write throughput one Postgres has not actually failed to deliver |

Observability is the part that is not optional at this rung. The framework's half is done `As of 2026-08` — metrics served and scraped, traces exported over OTLP/HTTP JSON, sampling head-based — and what is left is the cluster's: a custom-metrics adapter, a collector, and retention. See [Where the invariant breaks today](#where-the-invariant-breaks-today), item 3.

---

## The seam table

Every scale component, and exactly what to swap.

| Concern | Package · interface | Production implementation | `app.config.ts` | Env key that actually decides | Status |
|---|---|---|---|---|---|
| Rows / SQL | `@ultimat3/db` · `DbClient`, `ReservableClient` | `createPostgresClient()` over `Bun.SQL`; `setDbClient()` overrides | `database.driver`, `database.ssl` — `urlEnv`, `poolSize` and `schema` were deleted in 4.0.0, each read by nothing | `DATABASE_URL` | shipped |
| Embedded dev DB | `@ultimat3/db` · `PgliteClient` | `createPgliteClient()` | — | unset `DATABASE_URL` | shipped, `x dev` only |
| Repository | `@ultimat3/entity` · `Repo`, `Driver` | `postgresRepo()`; `memoryRepo()` for tests | — | — | shipped |
| Pool sizing | `@ultimat3/db` · `POOL_PROFILES` | per-`ROLE` max / statement timeout / idle timeout | — | `ROLE` | shipped |
| Cache, per-request | `@ultimat3/cache` · `CacheTier` | request memo | `cache.tiers: ['request-memo']` | — | shipped |
| Cache, per-process | `@ultimat3/cache` · `CacheTier` | LRU | `cache.tiers: ['lru']` | — | shipped |
| Cache, cross-node | `@ultimat3/cache` · `CacheTier`, `RedisLike` | `createRedisTier()` over `Bun.redis` | `cache.tiers: ['redis']` | `REDIS_URL` | shipped |
| Cache, edge | `@ultimat3/cache` · `CacheTier` | CDN headers + purge (Cloudflare, Fastly, HTTP) | `cache.tiers: ['cdn']` | purge-provider env | shipped |
| Job queue | `@ultimat3/jobs` · `JobDriver` (`enqueue`/`claim`/`ack`/`nack`/`heartbeat`/`stats`) | `createPgDriver()`; `setJobDriver()` installs it | **none** — `jobs.driver` was deleted in 5.0.0 and `setJobDriver()` is the only switch | `DATABASE_URL` | shipped |
| Job queue, Redis | same interface | `createRedisDriver()` — Streams + consumer groups + `XAUTOCLAIM` | none; `setJobDriver(createRedisDriver())` | `REDIS_URL` | **interface-complete stub, throws `X_NOT_IMPLEMENTED`** |
| Job queue, NATS | same interface | `createNatsDriver()` — work-queue stream per queue, durable pull consumer, `ack_wait` as the visibility timeout, KV for steps | none; `setJobDriver(createNatsDriver())` | `NATS_URL` | **interface-complete stub, throws `X_NOT_IMPLEMENTED`** |
| Scheduler leader | `@ultimat3/jobs` · `createPgLeaseLeader` | `SQL_LEADER_ACQUIRE` / `SQL_LEADER_RELEASE` — an expiring row in `x_scheduler_leader`, TTL 30s, `acquire()` doubling as the renewal. **Never `pg_try_advisory_lock`**: it is session-scoped, and the executor is a pool, so the grant dies when the connection returns and every node reads itself as leader | — | — | shipped |
| Realtime fanout | `@ultimat3/realtime` · `Transport`, via `selectTransport(env)` | `InProcessTransport` \| `NatsTransport` | `realtime.transport` (declarative) | `NATS_URL` | shipped |
| Presence | `@ultimat3/realtime` · JetStream KV | bucket, default `x_presence`, TTL 30s | — | `NATS_KV_BUCKET` | shipped |
| Change feed | `@ultimat3/realtime` · `ChangeFeed`, via `selectChangeFeed(env)` | `InMemoryChangeFeed` \| `PgLogicalReplicationFeed` (own PG v3 client, SCRAM-SHA-256, CopyBoth, `pgoutput`) | — | `REPLICATION_URL`, `REPLICATION_SLOT`, `REPLICATION_PUBLICATION` | shipped |
| Replicator singleton | `@ultimat3/realtime` · `AdvisoryLock` | `PgAdvisoryLock` (`pg_try_advisory_lock(hashtext(key))`, session-scoped) | — | — | shipped |
| Migration lock | `@ultimat3/db` · `MIGRATION_LOCK_KEY` | `pg_advisory_lock(4919202607)` on a pool pinned to `max: 1` | — | — | shipped |
| Object storage | `@ultimat3/storage` · `Driver` | `driver-local` \| `driver-s3` | — | `S3_ENDPOINT`, `S3_*` | shipped |
| Mail | `@ultimat3/mail` · `Driver` | `driver-smtp` \| `driver-resend` | — | mail env | shipped |
| Vector search | `@ultimat3/ai` · `PgVectorStore` | pgvector: `hnsw` on `vector_cosine_ops`, two `gin` indexes, generated `tsvector` | — | `DATABASE_URL` | shipped, Postgres-only — see below |
| Tracing | `@ultimat3/core` · `SpanExporter`, `configureTelemetry()` | `noopExporter` (default) \| `memoryExporter` \| `otlpSpanExporter()` over OTLP/HTTP JSON | — | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER_ARG` | shipped — **HTTP JSON only**, gRPC refused |
| Metrics | `@ultimat3/core` · `Counter`/`Gauge`/`Histogram`, `MetricExporter`, `metricsText()` | no-op exporter by default, memory exporter for tests; Prometheus text with no dependency | — | `METRICS_PORT` (default 9090) | shipped and wired — every role serves `METRICS_PATH`; `http`/`realtime`/`jobs` each hold one call site; the chart declares the port, publishes it and ships an opt-in ServiceMonitor |
| Secrets in logs | `@ultimat3/core` · `Secret`, `revealSecret()` | redacts by value at any depth, frozen so a spread cannot unwrap it | env declared `secret: true` | — | shipped |
| Which deploy this is | `@ultimat3/core` · `resolveEnvironment()` | `development \| test \| staging \| production` | — | `ULTIMATE_ENV` | shipped |
| `.env.example` | `@ultimat3/core` · `renderEnvExample()`, `assertEnvExample()` | projected from the `defineEnv` declaration | — | — | shipped |
| Admission control | `@ultimat3/realtime` · `AcceptBudget` | token bucket, 500/s default, burst 2000 | — | — | shipped |

Rule that survives every rung: **an unset variable means the embedded default.** No `NATS_URL` means in-process fanout. No `DATABASE_URL` means PGlite. No `REDIS_URL` means the shared tier is absent, not broken.

---

## Where the invariant breaks today

`As of 2026-08-22`, verified against the code, not the docs.

1. **`x build --target binary` has never been served from a VM.** The artifact starts `As of 2026-08` — the version read is resolved on first call and from `--define ULTIMATE_FRAMEWORK_VERSION` when there is no manifest ([`packages/core/src/version.ts`](../../packages/core/src/version.ts)), which is what `x build` passes, and [`packages/core/e2e/version.e2e.test.ts`](../../packages/core/e2e/version.e2e.test.ts) compiles a real executable and runs it on every push. What is unmeasured is the rest: booting is not serving, and the binary is a launcher for an app tree that must sit beside its source. (Fixed since the previous revision of this list: it threw at import and could not start at all.)
2. **The compose topology caps the two roles that publish a host port at one replica.** A published host port has exactly one binder, so `web` and `sync` declare `replicas: 1` in every copy of `docker-compose.prod.yml` — framework, both tracked apps and `x new`'s scaffold — instead of declaring more and starting one. That is the rung, not a defect (`worker` has no published port and scales freely); scaling `web` or `sync` on one box is a reverse proxy you add. The break this row used to carry — no chart from `x new`, so rung 2 → 3 meant copying `docker/helm/` by hand — is **closed** in 4.0.0: `x new` writes `docker/helm`, 8 files, and `x deploy --method helm` runs against it.
3. **Observability is wired end to end; two limits are permanent by choice.** [`packages/core/src/metrics.ts`](../../packages/core/src/metrics.ts) ships counters, gauges, histograms, a `MetricExporter` seam and a Prometheus-text renderer, [`runtime-metrics.ts`](../../packages/core/src/runtime-metrics.ts) declares the chart's three series keyed by `ScalingSignal`, and `As of 2026-08` the call sites exist: `pipeline.ts` counts every request in a `finally`, `SocketRegistry.add`/`remove` moves the connection gauge, `worker.ts` publishes queue depth every 15s. Every role serves `METRICS_PATH` on `METRICS_PORT` (default 9090) — a separate port, because the Helm ingress routes `/` with no path exclusion and metrics on the app port would be public. The chart side landed too: `values.yaml` declares `metricsPort: 9090`, `_helpers.tpl` emits a `metrics` containerPort on every role except `migrate` (which opens no socket and exits), `service.yaml` publishes it by name, and [`servicemonitor.yaml`](../../docker/helm/templates/servicemonitor.yaml) ships the scrape target — off by default only because a cluster with no Prometheus operator has no such CRD, so `serviceMonitor.enabled: true` is the one value an operator sets. **The exporter landed too.** `otlpSpanExporter()` and `otlpMetricExporter()` speak OTLP/HTTP JSON over `fetch` + `JSON.stringify` and read `OTEL_EXPORTER_OTLP_ENDPOINT` — no new dependency, the same reasoning that hand-wrote Prometheus exposition. Spans batch and the batches are **chained, not concurrent**, because a collector that reorders one process's batches turns a parent arriving after its child into a broken trace. Head-based sampling ships with it (`parentBasedRatioSampler`, `OTEL_TRACES_SAMPLER_ARG`), and `span.end()` now honours `traceFlags`, so an upstream's do-not-sample decision is no longer propagated and then ignored locally. **What is left is two stated limits, not gaps to close.** gRPC OTLP on `:4317` is refused with `X_OTLP_PROTOCOL_UNSUPPORTED` and will stay refused — HTTP/2 plus protobuf is a dependency and a second wire format; point the collector's HTTP receiver at `:4318`. There is **no logs signal**, and a rejected POST is dropped with a `warn` rather than retried, so an outage in the collector loses that window rather than backing it up ([`packages/core/src/otlp.ts`](../../packages/core/src/otlp.ts), [`docs/ops/03-observability.md`](../ops/03-observability.md)).
4. **Config keys that are accepted and ignored are now a gate, not a habit** — `bun run scripts/config-readers.ts` refuses an `AppConfig` leaf key with no reader in `packages/*/src`. Twelve had shipped before it existed, each found by hand in a major: `jobs.driver` (5.0.0), `realtime.heartbeatMs` / `database.urlEnv` / `database.poolSize` / `database.schema` (4.0.0), `pwa.installPrompt` / `auth.afterSignInPath` / `ai.modelEnv` (2026-08). What is left is a pin list with a sentence per key (`scripts/lib/config-reader-pins.ts`), and one entry on it is the same defect not yet spent: `realtime.urlEnv` is **validated and never dereferenced** — `dev-services.ts` reads the literal `NATS_URL`, so `urlEnv: 'MY_NATS'` makes nothing read `MY_NATS`. It is pinned rather than deleted because deleting a config key is breaking and belongs to a release; `cache.urlEnv` was the other one and 9.0.0 spent it, with `cache.driver`. `realtime.transport: 'redis'` still type-checks and still builds in-process or NATS, never Redis.
5. **The runtime switch is env, not `app.config.ts`.** Nothing at boot reads `config.realtime.transport`; `selectTransport(env)` reads `NATS_URL` and `selectChangeFeed(env)` reads `DATABASE_URL`/`REPLICATION_URL`. This is correct for one-image-everywhere, and it means the ladder is climbed with env vars while the config field documents intent.
6. **Assembling the cache stack is config-driven `As of 2026-08-22`.** `startCacheTiers` builds exactly the rungs `cache.tiers` names and refuses the boot on one the environment cannot supply. It was app-side until 9.0.0, when the same release deleted `cache.driver` — the second, unread way to ask for the Redis rung.
7. **A transaction-pooling proxy in front of Postgres breaks three things.** Session-level advisory locks are the migration lock and the replicator singleton — both assume one session holds the lock for its lifetime. The scheduler leader is not one: it is a lease row, precisely because a pool cannot promise that. An operator running this stack records the second half too: transaction pooling breaks server-side prepared statements (`SQLSTATE 26000`), and clients that cannot disable them connect direct. Route every role to the primary directly, or to a session-pooling mode.

8. **The shared cache tier is topology-clean, and unmeasured on a real cluster.** Both halves are **fixed** `As of 2026-08` ([`packages/cache/src/redis.ts`](../../packages/cache/src/redis.ts)): the script touches only the buckets it was handed and returns the value keys for the tier to `DEL` one at a time, and the buckets carry a `{entity}` hash tag while `invalidateTags` issues one call per tag — so every key of every call hashes to one slot by construction. `redis.test.ts` asserts the emitted keys; **no test runs against a real cluster node**, so rung 1's "add a shared cache" is any Redis-protocol server, with clustered deployments unmeasured rather than unsupported.

None of the eight is app code. That is the point — the **App code change: none** in every rung above survives all eight — and also why they are worth fixing, because every one of them is a rung the framework should have paid for on the author's behalf.

---

## YugabyteDB, honestly

Not a supported target. No test in this repo runs against YugabyteDB, and no dialect flag exists. What follows is a compatibility audit of the SQL this framework actually emits, so the size of the gap is known rather than assumed.

`As of 2026-08`:

| What the framework emits | Where | YugabyteDB |
|---|---|---|
| `pg_advisory_lock` / `pg_try_advisory_lock` / `pg_advisory_unlock` | `db/migrate.ts`, `jobs/driver-pg-sql.ts`, `realtime/pg-advisory-lock.ts`, `testing/template-db.ts` | **v2025.1+ only**, enabled by default, backed by a `pg_advisory_locks` system table so a lock is visible from every node. Earlier versions return a not-implemented error ([#3642](https://github.com/yugabyte/yugabyte-db/issues/3642), [docs](https://docs.yugabyte.com/stable/explore/transactions/explicit-locking/)) |
| `select … for update skip locked` | `jobs/driver-pg-sql.ts` `SQL_CLAIM` | supported under Read Committed and Snapshot, **not** Serializable. Read Committed is only itself when `yb_enable_read_committed_isolation` is on — default false before v2025.2, falling back to the stricter Snapshot ([docs](https://docs.yugabyte.com/stable/architecture/transactions/read-committed/)) |
| `SHOW wal_level`, `CREATE PUBLICATION`, `pg_create_logical_replication_slot(…, 'pgoutput')`, `START_REPLICATION` | `realtime/pg-replication.ts` | supported from 2024.1.1, still **Early Access**; `pgoutput` is bundled; `wal_level` checks are disabled and the default is reported as `logical`, so the framework's preflight passes ([docs](https://docs.yugabyte.com/stable/additional-features/change-data-capture/using-logical-replication/)) |
| `IDENTIFY SYSTEM` | **nowhere** | favourable. Yugabyte does not implement it, which is why it ships its own `pg_recvlogical` and warns against the stock one. The framework's client preflights with `SHOW wal_level`, `pg_publication`, `pg_replication_slots` and goes straight to `START_REPLICATION` — it never issues the one command that breaks stock clients |
| replica identity — never set by the framework | `realtime/pg-replication.ts` | **breaks by default.** Yugabyte's default replica identity is `CHANGE`, which is not a PostgreSQL value and which **`pgoutput` cannot decode** — replication fails if even one table in the database has it ([#28629](https://github.com/yugabyte/yugabyte-db/issues/28629)). Every replicated table needs `REPLICA IDENTITY FULL` or `DEFAULT` **before** the slot is created; changing it afterwards has no effect on an existing slot |
| LSN as a number — `commitPositionOf(lsn)` parses the first 16 hex digits into a `bigint`, `START_REPLICATION … LOGICAL <lsn>` resumes from it | `realtime/pg-replication.ts` | **caution.** In Yugabyte an LSN "uniquely identifies a change event and is valid only in the context of a specific replication slot" — not a WAL byte offset. Ordering holds inside one slot under the default `SEQUENCE` LSN type; arithmetic and cross-slot comparison do not |
| `LISTEN` / `NOTIFY` / `pg_notify` | **nowhere** | not a constraint either way. Verified by grep across `packages/`, `examples/`, `scripts/`, `docker/` — the change feed is logical replication and the job queue polls with `SKIP LOCKED`. (Yugabyte did ship LISTEN/NOTIFY as Early Access in v2025.2.3, default-off, delivered over internal CDC slots at 100–150ms and a few thousand notifies/sec — but nothing here needs it) |
| `create index … using gin (tsv)` and `using gin (metadata jsonb_path_ops)` | `ai/pg-vector-sql.ts` `ddlSql()` | **breaks.** Yugabyte's GIN is `ybgin`, created with `USING ybgin`; `ybgin` permits only single-term lookups and no multi-column GIN ([docs](https://docs.yugabyte.com/stable/explore/ysql-language-features/indexes-constraints/gin/)) |
| `create extension vector` + `using hnsw (embedding vector_cosine_ops)` | same file | works from v2025.1. `USING hnsw` is remapped to the distributed `ybhnsw` access method ([docs](https://docs.yugabyte.com/stable/additional-features/pg-extensions/extension-pgvector/)) |
| `gen_random_uuid()` on uuid primary keys | `db/generate.ts` | works, and is the *right* default here — a monotonic sequence PK hot-spots one tablet. The framework picked the distributed-friendly default already |
| `on conflict (idempotency_key) where … do nothing` against a partial unique index | `jobs/driver-pg-sql.ts` `SQL_ENQUEUE` | **unverified.** Test before trusting |
| `x_jobs_claim_idx on (queue, run_at)` + `order by run_at` | `jobs/driver-pg-sql.ts` | **works, but hotspots.** A monotonic range index concentrates every claim on one tablet. Yugabyte's own job-queue guidance is a `bucket smallint default floor(random()*4)` prefix column plus a 4-branch `UNION ALL` view to spread it ([docs](https://docs.yugabyte.com/stable/develop/data-modeling/common-patterns/jobqueue/)) |
| each migration's `up` run inside a transaction | `db/migrate.ts` | **not available.** v2026.1's release notes *disable* transactional DDL and table locks; the feature exists behind `ysql_yb_ddl_transaction_block_enabled` with "weaker isolation guarantees than PostgreSQL," and [#1404](https://github.com/yugabyte/yugabyte-db/issues/1404) is open since 2019. A migration that fails halfway does not roll back |
| `truncate` in a migration | app-authored SQL | not transactional on Yugabyte, and cannot be rolled back |
| `information_schema` + `pg_class` / `pg_index` / `pg_attribute` introspection | `db/introspect.ts` | **unverified.** The database half of drift detection rides on it — `checkDrift()`, run inside `x db migrate` and `ROLE=migrate`. `db` has no drift subcommand at all — the source half is the `drift` **step** of `x verify`, and it opens no database |

### The blocking findings

1. **Below v2025.1, YugabyteDB cannot run this framework at all.** No advisory locks means no migrations (`migrate()` takes `pg_advisory_lock(4919202607)` before it reads the ledger), no replicator singleton (`PgAdvisoryLock`, which owns its connection), and no parallel test template. Scheduler leader election is **not** on that list: it is an expiring row (`createPgLeaseLeader`), so it survives a database with no advisory locks — and it is a pool, not a session, that made the row the right shape in the first place. Two of the three fail closed with a typed error; the replicator one would let two replicators double-deliver.
2. **`@ultimat3/ai`'s vector store does not create its schema on YugabyteDB, at any version.** `ddlSql()` emits two `USING gin` indexes. The vector index is fine; hybrid search's full-text half and the metadata index are not — and `ybgin` would still refuse the multi-column and multi-term cases the FTS path needs.
3. **The `replicator` role does not start on a default Yugabyte database.** Its default replica identity, `CHANGE`, cannot be decoded by `pgoutput`, and one such table in the database is enough. Every replicated table needs `REPLICA IDENTITY FULL` before slot creation — a migration the framework does not write today.
4. **Migrations are no longer atomic.** `migrate()` runs each `up` inside `withTransaction`; v2026.1 disables transactional DDL. A migration that fails partway leaves the schema partly applied while the ledger row is absent — and the ledger's checksum audit then refuses to move forward. This is the failure that most needs a live test.

Beyond the four, `PgLogicalReplicationFeed` survives the rest of Yugabyte's CDC caveats by accident of design: it confirms the slot as it goes, treats `TRUNCATE` as advisory, never issues `IDENTIFY SYSTEM`, and never compares LSNs across slots. A `TRUNCATE` on a replicated table sending no record is a silent divergence for anything that truncates — the one caveat that still bites.

### What would have to change

None of it is app code:

| Change | Where |
|---|---|
| `USING gin` → `USING ybgin` behind a dialect flag | `packages/ai/src/pg-vector-sql.ts`, one call site |
| emit `ALTER TABLE … REPLICA IDENTITY FULL` for replicated tables, before the slot | `packages/db/src/generate.ts` / replication init |
| bucket-prefix the job claim index, or accept the hotspot | `packages/jobs/src/driver-pg-sql.ts` |
| refuse below v2025.1 with an executable fix; warn that DDL is not transactional | `x doctor` |
| a live suite pointed at a real cluster | `*.live.test.ts` |

**That work has not been done.** Until it is, "Ultimate runs on YugabyteDB" is a hypothesis with a known shape, not a claim.

### And the cost, stated

| Floor | Value |
|---|---|
| fault-tolerant minimum | 3 nodes (RF3 tolerates one loss); even replica counts buy nothing |
| managed minimum | 3 nodes × 4–8 vCPU, 4 GiB RAM per vCPU ([docs](https://docs.yugabyte.com/stable/yugabyte-cloud/cloud-basics/create-clusters-overview/)) |
| **self-hosted production recommendation** | **16+ cores and 64 GiB+ RAM per node** for YSQL, SSD required, plus 3 yb-master processes on their own VMs ([docs](https://docs.yugabyte.com/stable/deploy/checklist/)) |
| tablet overhead | ~0.4 vCPU and 800 MiB per 1000 tablet replicas for Raft heartbeats alone |
| write latency, stretched RF3 across US regions | ~30ms, vs ~2ms single-region — every write waits for a second region's replica |

One Postgres container on 4 vCPU and 8 GiB is not in the same cost class, and serves more applications than ever reach this rung. Single-row writes take Yugabyte's fast path; anything multi-shard writes provisional records on every affected tablet and coordinates through a transaction status tablet. **Climb this rung for geography or availability, never for throughput you have not measured.**

---

## Dragonfly, honestly

Redis wire-compatible on RESP2 and RESP3; existing clients connect unchanged. Licensed **BSL 1.1**, converting to Apache 2.0 on 2030-11-01 — self-hosting your own app is granted; reselling it as a hosted cache is not.

The framework's shared tier uses `GET`, `SET … EX`, `SADD`, `DEL`, `SMEMBERS` and two scripts ([`packages/cache/src/redis.ts`](../../packages/cache/src/redis.ts)). Five core commands, and the scripts now survive the move.

### The former blocker: `invalidateTags` used undeclared keys

Dragonfly enforces that a Lua script may only touch keys passed in `KEYS` — `CheckKeysDeclared()`, rejected otherwise ([docs](https://www.dragonflydb.io/docs/managing-dragonfly/scripting)). `REDIS_INVALIDATE_SCRIPT` used to pass only the **tag-set** keys and then `DEL` the members it found at runtime, which those rules refuse.

**Fixed `As of 2026-08`.** The script `SMEMBERS` each declared tag key, `DEL`s that tag key, and **returns** the member list; the tier deletes the value keys client-side, one key per `DEL` ([`packages/cache/src/redis.ts`](../../packages/cache/src/redis.ts)). The cost is the one that was always going to be paid — the value deletes are no longer inside the script — and it is the right one: a value key re-added by a concurrent write between the two halves is a cache miss, never a stale read. Dragonfly runs the shared tier unmodified, and `allow-undeclared-keys`, whose price is a global lock on every invalidation, is not needed.

**Cluster mode is no longer the cache seam's problem.** `--cluster_mode=yes` requires every key of a multi-key operation, transaction or Lua script to live in one slot ([docs](https://github.com/dragonflydb/dragonfly/blob/main/docs/cluster-mode.md)) — still the rule, and the buckets now carry a `{entity}` hash tag while `invalidateTags` issues one call per tag, so every key of a call co-slots by construction ([`05-caching.md`](./05-caching.md)). What remains is Dragonfly's own: `--cluster_mode=yes` forbids `SELECT` and rejects global `PUBLISH`/`SUBSCRIBE`, and Dragonfly ships only the cluster **data plane** — no gossip, no `ASKING`, failover and slot rebalancing explicitly out of scope for the open-source server. No test in this repo runs against a clustered node of any engine.

Two more properties worth knowing before choosing it:

- **No AOF, by design and by policy** — snapshot-only durability, `snapshot_cron` granularity one minute, so the worst-case loss window is at least a minute and unbounded on an unclean crash. Correct for a cache regenerable from Postgres; wrong for anything durable.
- **Keyspace notifications are limited to expired-key events** (`notify_keyspace_events` accepts only `EX`). The framework does not use them; any invalidation design that reaches for them will not port.

If the cache seam is fixed, this is what running it costs. Operational evidence from an operator running eight Dragonfly instances in Kubernetes for other applications, `As of 2026-08`:

| Lesson | Detail |
|---|---|
| scale by adding pools, not by clustering | eight single-replica instances, `--cluster_mode` used nowhere; a public/untrusted workload and an error-reporting workload each get their own pool so neither can evict a neighbour's cache |
| `--maxmemory` must be ≥ `proactor_threads` × 256 MiB | Dragonfly reserves ~256 MiB per proactor thread and **self-exits at boot** otherwise — never binds 6379, permanent CrashLoopBackOff. A `256mb` / 2-thread pod produced 148 restarts in 12 hours. It is a startup refusal, not an OOMKill, so the memory limit is irrelevant to it and only `--previous` logs show it |
| `--cache_mode=true` means eviction, and eviction destroys queues | a job queue on an evicting cache silently drops work. Queue pools run `noeviction` and snapshot to a PVC; cache pools evict and are never backed up (regenerable from Postgres — an accepted risk, written down as one) |
| the container memory limit must exceed `--maxmemory` | 768 Mi limit over `512mb`, 1 Gi over `768mb`, 5 Gi over `4gb` |
| `capabilities: drop: [ALL]` crashloops the official image | its entrypoint calls `setpriv`. NATS tolerates dropping all caps; Dragonfly does not |
| metrics arrive on 6379 | Dragonfly protocol-sniffs and serves Prometheus on the data port — no separate metrics port |
| logical DB-index separation is not a security boundary | one shared pool with `--dbnum=1024` and one index per app still means any compromised pod can read and write every index |

---

## NATS, honestly

Apache-2.0, and it stayed that way: the 2025 Synadia/CNCF trademark dispute resolved on 2025-05-01 with the trademarks assigned to the Linux Foundation, the domain and repos with CNCF, and the server still Apache-2.0. Only Synadia's commercial products are proprietary.

The framework speaks NATS through the official `nats` client (`nats@2.29.3`, pinned exact — its one external runtime dependency, `As of 2026-08`, admitted at the transport seam behind a port: [`18-build-vs-wrap.md`](./18-build-vs-wrap.md)), and needs JetStream, because presence is a KV bucket and the bucket's per-message TTL and batch direct get landed in **2.11**. Those two are also why the bucket is built on the JetStream API directly rather than on the library's KV, which expresses neither. An older server fails the first dial with `X_TRANSPORT_PROTOCOL`.

**2.11 is the floor, not the version to run.** NATS supports the current and previous minor series only; as of 2026-08 that is **2.14** and **2.12**, and 2.11 is end-of-life. `docker-compose.dev.yml` pins `nats:2.11-alpine` — correct as a compatibility floor, stale as a deployment. Pin 2.12 or 2.14 in production.

What the framework uses NATS for today: **fanout and presence only.** The NATS *jobs* driver is a stub. Its intended mapping is written down and has no design decisions left — a JetStream work-queue stream per queue, a durable pull consumer per worker pool where `fetch` is `claim` and `ack`/`nak` map 1:1, `ack_wait` as the visibility timeout, and a KV bucket for step records ([`packages/jobs/src/driver-nats.ts`](../../packages/jobs/src/driver-nats.ts)). Every piece exists: pull consumers with explicit ack, `MaxDeliver` bounding redelivery, `Nats-Msg-Id` deduplication ([docs](https://docs.nats.io/nats-concepts/jetstream/consumers)). Three constraints that mapping will meet, worth knowing before it is written:

| Constraint | Consequence for the driver |
|---|---|
| a work-queue stream allows **one consumer per subject** — filters must not overlap | many workers means many clients pulling one consumer, not one consumer each |
| the `Nats-Msg-Id` dedupe window is **2 minutes by default, per stream, and not durable across restart or leader change** ([#3272](https://github.com/nats-io/nats-server/issues/3272), open since 2022) | `idempotencyKey` cannot move from the partial unique index to the dedupe window without losing a guarantee the `pg` driver gives today |
| there is **no built-in dead-letter queue** — exhaustion publishes an advisory on `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>` | `x jobs retry` and the dead-letter state must be rebuilt on that advisory |

Operational evidence from an operator running JetStream in Kubernetes, `As of 2026-08`:

| Lesson | Detail |
|---|---|
| JetStream must be enabled twice | server-side `jetstream {}` **and** per-account limits in the account JWT under operator mode; an account with no JS limits answers "JetStream not enabled" |
| keep the file store under the volume | `max_file_store: 8GiB` on a 10 Gi PVC, so the store can never fill the disk it lives on |
| let the app own its streams | streams and KV buckets are created idempotently by the application at connect; infrastructure defining them too is two owners fighting |
| drain properly | `preStop` runs the lame-duck shutdown; `terminationGracePeriodSeconds: 60`; liveness on `/healthz?js-enabled-only=true` |
| one URL for everyone | in-cluster and off-cluster clients dial the same public TLS endpoint, because a public certificate cannot carry an in-cluster SAN |
| single server is a real deployment | 100m CPU / 256 Mi requested, 768 Mi limit, one replica, no clustering. R3 is a rung-4 decision, not a starting point |
| absence of alerts is not absence of failure | no JetStream alert rules existed, and one rollout publish that never reached its target was found by hand, not by an alert |

### Durability, honestly

JetStream's file store fsyncs on `sync_interval`, **default 2 minutes** — not per write. Jepsen's 2025-12 report on 2.12.1 found that a correlated OS crash lost 14.1% of acked messages in one run, and that single-bit corruption on a *minority* of an R5 cluster could lose acked records from the middle of the log or cause nodes to delete their own data directory. All four issues were still open `As of 2026-08`, and the default was not changed ([report](https://jepsen.io/analyses/nats-2.12.1)). Simple partitions, process pauses and crashes did **not** lose data.

For what the framework stores on NATS today — fanout and presence, both reconstructible — none of that matters. It starts mattering the day the NATS jobs driver lands, and then `sync_interval: always` on the queue streams is the price of a job that cannot be lost. R3 also only buys anything if the three replicas sit in independent failure domains.

---

## When not to climb

The most valuable advice on this page.

| Do not climb to | Until |
|---|---|
| a paid plan at all (off rung 0) | the free instance's sleep costs you a cron you need, or a cold start your users notice, or the free Postgres refuses a connection. Free is a real rung, not a demo |
| a second process type (rung 1) | you have a job that must outlive its request, or a cron. Not before |
| a shared cache tier (rung 1) | you run more than one web replica **and** have measured a cross-replica miss that costs you. `memo` + `lru` serve most read-heavy apps from one process |
| your own box (rung 2) | the PaaS bill exceeds a server plus the hours to run it, or a platform limit actually blocks you |
| NATS (rung 3) | you run more than one `sync` replica. `InProcessTransport` is correct and free at one node — and the measured 50k-socket result was taken on one node, in process |
| the `replicator` role (rung 3) | you use live queries. The chart ships it disabled |
| Kubernetes (rung 3) | you have roughly three nodes of real workload. One 6-vCPU / 12-GiB host runs Postgres, a cache, NATS and all six roles under Compose |
| splitting a database off (rung 4) | a database sustains >50% CPU or >75% IO utilisation, or an app needs an extension that is not safe cluster-wide, or compliance forces separation. Until then: share |
| distributed SQL (rung 4) | you need multi-region write locality, or must survive a zone loss without a manual failover. Throughput alone is not a reason |
| Dragonfly at all | one Redis or Valkey node is no longer enough on memory or throughput. The cache seam no longer votes `As of 2026-08` — every key a script touches is declared and slot-clean, so the choice is operational, and [below](#dragonfly-honestly) is what it costs |

Two rules underneath all of them:

- **A rung you cannot observe is a rung you cannot operate.** Climbing from 2 to 3 without metrics moves the failure from "the box is slow" to "one of eleven pods is slow and nothing says which".
- **A live test that exercises only the surface you touched is a false pass.** Swapping a driver means re-running the gate, not re-checking the one call you changed.

## True today vs intended

| Claim | State |
|---|---|
| one image, `ROLE` selects the process | **true** — `packages/core/src/roles.ts`, `docker/Dockerfile` |
| Postgres job queue with `SKIP LOCKED`, partial-unique idempotency, lease-row leader | **true** — `packages/jobs/src/driver-pg-sql.ts` |
| Redis and NATS job drivers | **stubs** — interface-complete, every method throws `X_NOT_IMPLEMENTED` |
| shared cache tier over the Redis protocol, tag sets, declared-key invalidation | **true** — `packages/cache/src/redis.ts`; one call per tag over `{entity}`-tagged buckets, then the value keys one `DEL` each, plus single-flight, TTL jitter and a bucket lease |
| NATS fanout and JetStream KV presence | **true** — `packages/realtime/src/nats-transport.ts`, selected by `NATS_URL` |
| Postgres logical replication change feed, `pgoutput`, own wire client | **true** — `packages/realtime/src/pg-replication.ts` |
| 50k sockets, forced restart, p50 54.0s to the first patch on the reconnected socket | **measured** — one node, in-process transport, `scripts/bench/results/50k-restart.json`. Reachability; it cannot see a lost patch |
| channel patches delivered across a forced restart, no client observing a gap | **measured at 10k, not at 50k** — 1,666,882 received, 0 observed sequence gaps, a lower bound on loss, `scripts/bench/results/10k-restart-seq.json` |
| Compose prod topology | **true, and emitted by `x new`** — `web` and `sync` at `replicas: 1` because each publishes a host port; `worker` scales freely |
| A Helm chart with per-role HPAs | **true in the framework repo**, not emitted by `x new` |
| tracing with `traceparent` across HTTP → job → live query | **true**, and exportable — `otlpSpanExporter()` over OTLP/HTTP JSON, batched and chained; no-op remains the default |
| a metric API, a `MetricExporter` seam, Prometheus text | **true** — `packages/core/src/metrics.ts`, new in 1.1.0 |
| `/metrics` served, and HPA signals emitted by the app | **shipped** — every role on `METRICS_PORT`, three call sites, a `metrics` containerPort and Service port in the chart, and an opt-in ServiceMonitor |
| `x build --target docker\|static` producing an artifact from `x new` output | **true** — the scaffold writes `apps/web/server.ts` and `prerender.ts` |
| `x build --target binary` producing a runnable artifact | **starts** — compiled and executed by an e2e on every push; never served from a VM |
| a value that must not be printed staying out of the log | **true** — `Secret` redacts by value, at any depth |
| the demo app on Compose **and** Kubernetes from one image, rolling restart invisible | **open** — roadmap milestone 11 ([`14-roadmap.md`](./14-roadmap.md)) |
| YugabyteDB as a target | **untested, with four known blockers** — advisory locks below v2025.1, `USING gin`, replica identity `CHANGE`, non-transactional DDL |
| Redis / Valkey as the shared tier | **true** — five core commands and one declared-keys `EVAL` |
| Dragonfly as the shared tier | **true** — `invalidateTags` declares every key it touches and co-slots them under `{entity}` `As of 2026-08`. **Unmeasured** on any clustered node, of any engine |
| NATS 2.11 as the pinned dev server | **stale** — 2.11 is end-of-life; supported series are 2.12 and 2.14 |
