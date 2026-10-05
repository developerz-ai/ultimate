# Deployment

One image, N roles. Build once; the `ROLE` env var selects behavior. No role-specific Dockerfile, no per-role dependency set, no drift between what you tested and what runs.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). All three artifact targets ship — `x build --target docker`, `x build --target binary`, `x build --target static` — plus `x build --target prebuilt`, the step the app image runs on itself (`As of 2026-10`), and so do the compose files and the Helm chart. Milestone 11 is 🚧 on one thing ([roadmap](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md)): the two-platform proof — the demo app on Compose **and** on K8s from one image, with a rolling restart invisible to connected clients.

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
| `scheduler` | cron dispatch → enqueue only | **fixed 1** | leader election is an expiring row in `x_scheduler_leader` (`createPgLeaseLeader`), never an advisory lock — that grant is session-scoped and the executor is a pool. A second instance is a warm standby, not a duplicate |
| `migrate` | run-once, pre-deploy | n/a | applies migrations through the ledger and **exits**; never binds a port. Holds the migration advisory lock on one pinned session for the whole run, so overlapping deploys serialise — the second waits, polling once per 500ms for up to 60s, then exits non-zero with `X_MIGRATE_CONCURRENT` rather than hanging the rollout (`As of 2026-08`; 1.2.0 waits forever — [Known gaps](Known-Gaps)) |
| `replicator` | logical replication → change feed → matcher → NATS | **1 per database** | owns the replication slot; a second instance would double-deliver, so it takes an advisory lock and exits if held |

- No role holds durable state. Everything survivable is in Postgres, NATS, or object storage.
- A role that cannot get its lock **exits non-zero with a typed error** rather than running degraded.
- **There is no `ROLE=all`.** Those six names are the whole set; anything else is `X_ROLE_UNKNOWN` at boot. For dev, `x dev` co-locates `web`, `sync`, `worker` and `scheduler` in one process — role isolation is simulated, not skipped, and `--role` opts the `replicator` in.

`PORT` selects the bind port, default `3000`. Empty or whitespace falls back to the default; anything else must be an integer in 0–65535 or the process refuses with `X_PORT_INVALID` rather than quietly binding 3000 and failing the platform's health probe with nothing in the log that names the cause. The production entry is the scaffolded `apps/web/server.ts` → [CLI reference](CLI-Reference).

## Health endpoints

**`web` and `sync` serve both; nothing else does.** They are the two roles that construct an HTTP server — `worker`, `scheduler` and `replicator` open the metrics listener alone, so probe those on `/metrics`. Both endpoints return a body, never a bare `200 OK`.

| Endpoint | Answers | 503 when | Consumer |
|---|---|---|---|
| `/healthz` | "is this process alive?" | the lifecycle is `stopped`. Ignores the readiness checks on purpose: a database outage that failed liveness fleet-wide restarts every pod into the same outage, cold | liveness probe → restart |
| `/readyz` | "should traffic come here?" | starting, **draining**, stopped, or any registered check answers `failing` | readiness probe → remove from rotation |

The body is `{ state, ready, role }` for everyone, and `{ state, ready, uptimeMs, inflight, buildId, checks, registered, role }` — `checks` a **map** of name → `ok` / `failing` — for a peer `configureHttp({ healthDetailPeers })` lists (default `['loopback']`: `kubectl exec`, a port-forward, the container's own healthcheck). The status code is the same for both, and is all a probe reads. A published container port is NOT loopback: the caller arrives from the bridge gateway, so list `'private'` to read the detail through `-p`. The `sync` role's own port answers by the same list, and tells a request carrying `Forwarded` or `X-Forwarded-For` the verdict only.

| Registered check | When it exists | What it reads |
|---|---|---|
| `database` | always | the previous `db.ping()`, refreshed on read — never awaited inside the probe |
| `transport` | only when the transport can report a connection: NATS can, the in-process bus cannot | `transport.connected` |
| anything per-role | **never** `As of 2026-08-22` | this table used to list five — replication lag, migration-version skew, "one pool claiming", "holds the leader lock", "slot active" — and none was wired. A `scheduler` standby does not report not-ready; it serves no readiness endpoint |

**`health: { readiness: 'process' }` in `app.config.ts`** (`As of 22.5`; default `'dependencies'`). Every replica shares the database, so one blip fails `database` everywhere at once and the ingress answers "no available server" for the whole site — pages that never touch the database included. In `'process'` mode `/readyz` is 503 only while starting, draining or stopped; a failing check stays 200 with `ready: true` and the check still named `failing` in `checks`. `/readyz?deep=1` always answers in `'dependencies'` mode — point monitoring there. Web and sync roles alike; liveness is unchanged in both modes.

**`registered: 0` is a real answer, not an error.** An empty registry is still ready, so a 200 means no more than "the socket is bound" — which is what the chart's and compose's healthchecks route traffic on. Read `registered` before you trust `checks: {}`.

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
| `worker` | abort every held job's `ctx.signal` with `X_DRAINING` at step 2, so a body that reads it unwinds inside the budget; a job that stops is handed back uncounted and the worker replacing this one resumes it at its last recorded step. A body that ignores the signal is waited on to the deadline and its lease lapses |
| `scheduler` | delete the lease row immediately so the standby promotes on its next round rather than waiting out the 30s TTL |
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
x build --target prebuilt   # the line the Dockerfile runs INSIDE the image build
```

| Target | Output | Use |
|---|---|---|
| `docker` | one OCI image, `ROLE` selects behavior | the normal path |
| `binary` | `.x/app` — `bun build --compile`, all roles inside. Boots `As of 2026-08`; **not yet served from a bare VM** ([Known gaps](Known-Gaps)) | VMs, systemd, air-gapped, a CLI-shaped product |
| `static` | `.x/static` — 0kb-JS pages, hashed assets, `sitemap.xml`, `robots.txt`, feeds | CDN / object storage, deployed independently |
| `prebuilt` | `node_modules/.cache/ultimate/` — every island chunk and every compiled stylesheet. No gate, no subprocess, takes neither `--tag` nor `--out` | never by hand: it is `docker`'s other half, a `RUN` line in the image |

### What a pod boots from

**A pod builds nothing at boot.** `As of 2026-10-01`. The scaffolded Dockerfile carries, after `COPY . .`:

```dockerfile
RUN bun node_modules/@ultimat3/cli/src/bin.ts build --target prebuilt
```

| Rule | Why |
|---|---|
| it runs in the image build, never on the host | the store is valid for one Bun, one framework version and one set of absolute paths — the image's |
| above `ENV NODE_ENV=production` | it imports the app with no deployment environment; in production `app.config.ts` asks for values no image build has |
| above `ARG BUILD_ID` | two images differing only by their stamp share the layer |
| it writes under `node_modules/`, not `.x/` | `.x/` is state: every ignore file drops it and the compose topology mounts a tmpfs over it |
| a module that will not import fails the image build | its stylesheets would be missing, and every pod would compile them |

An image without the line still serves. Every boot then runs Babel over every island and Sass over
every stylesheet, and logs one `error` line saying so — `X_IMAGE_NOT_PREBUILT`, with the counts,
the milliseconds and the line above. Measured on the demo app's image, `ROLE=web`, four boots each:

| | time to ready | boot CPU | peak RSS | settled RSS |
|---|---|---|---|---|
| no store | 4.2–4.8 s | 8.3–9.5 CPU-s | 244–269 Mi | 215–220 Mi |
| prebuilt | 1.6–1.7 s | 1.8–2.0 CPU-s | 141–147 Mi | 97–102 Mi |

**An app scaffolded before 23.0.0 does not have the line** — its `docker/Dockerfile` is the app's
own file. Add it; the boot log names it until you do ([Upgrading](Upgrading)).

All targets share one build ID (content hash), stamped into the image, the HTML, the assets, `x.manifest.json` — **and `sw.js`**, `As of 2026-08`: the worker's cache names carry the build id, so a deploy retires the previous build's caches instead of serving them ([#390](https://github.com/developerz-ai/ultimate/issues/390)). Every target that serves or writes a document emits `manifest.webmanifest`, `sw.js` and `x-sw-register.js` alike ([PWA and offline](PWA-And-Offline)).

```
$ x build --target docker
  ✓ typecheck + boundaries           ✓ site/  12 routes  static   0kb js
  ✓ app/   31 routes  stream         ✓ static assets     avif+webp, 214 files
  ✓ manifest + openapi emitted       ✓ image  myapp:8f2a1c9  118MB
                                       build id 8f2a1c9
```

`x build` runs six of `x verify`'s steps first — `typecheck`, `lint`, `boundaries`, `filesize`, `package-shape`, `errors` — and produces no artifact if any fail. It also refuses before spawning the builder when the target's entry file is missing (`X_BUILD_ENTRY_MISSING`) → [CLI reference](CLI-Reference).

## Dev compose

```yaml
# docker/docker-compose.dev.yml — only needed for parity checks; `x dev` needs none of this
services:
  db:   { image: postgres:17-alpine, ports: ['127.0.0.1:5432:5432'] }
  nats: { image: nats:2-alpine, command: ['-js'], ports: ['127.0.0.1:4222:4222'] }
  s3:   { image: versity/versitygw:v1.8.0, ports: ['127.0.0.1:9000:9000'], volumes: ['s3bucket:/data/myapp'] }
```

`x dev` uses embedded Postgres, in-process NATS, and a local directory for S3 — **Docker is not required to develop.** This file exists for parity debugging: three backing services and no `app` service, because the app in development is `x dev` on the host, pointed at them by environment (the file's header is the line to paste).

| Service | Rule |
|---|---|
| every port | binds `127.0.0.1` — the credentials are in the file |
| `s3` | Versity S3 Gateway over a directory. A directory under `/data` is a bucket, so the volume mounted at `/data/<app>` **is** the bucket: ready on the first `up`, no CreateBucket call |
| `S3_REGION` | not needed against it: an unset region signs for `auto`, and the gateway is started with that region. An endpoint that expects another refuses the first write with `X_CONFIG_INVALID`, naming the value to set |
| production | any S3-compatible endpoint. This file picks a server for a laptop, never for a deployment |

## Prod compose

```yaml
# docker/docker-compose.prod.yml
x-app: &app
  image: myapp:${BUILD_ID}
  env_file: [../.env.production]   # what the CONTAINERS see — not what `${VAR:?}` reads
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
| `SYNC_URL=ws://<host>:3001/_x/sync` in `.env.production`, read through `--env-file` | a page dials `/_x/sync` on its own origin by default, and on this rung that is `web`'s port, which does not serve the socket. With no proxy in front, only the deployment knows where `sync` is published. The shipped compose file refuses to start `web` without it (`${SYNC_URL:?…}`). Must be `ws://` or `wss://`, else `X_CONFIG_INVALID` at boot. Since 21.0.0. |
| `APP_URL=http://<host>:3000` in `.env.production`, reaching `sync` | the sync node admits a socket from `APP_URL`'s origin and no other once one is declared — scheme, host and port, exactly; with none declared, from the origin it was reached on. On this rung the page is `:3000` and the socket `:3001`, two origins, so without it every upgrade is `403 X_SOCKET_ORIGIN_REFUSED`. The shipped compose file refuses to start `sync` without it (`${APP_URL:?…}`). One proxy serving both on one host needs none (a PaaS: a node reached over plain http admits the `https` spelling of that host and port), and the Helm chart sets `APP_URL` on the sync role from `ingress.host` |
| `POSTGRES_PASSWORD` in `.env.production`, read through `--env-file` | `x new`'s compose file runs its own `db` service and refuses to start it without one (`${POSTGRES_PASSWORD:?…}`) |
| every command passes `--env-file .env.production`, before `-f` | Compose interpolates `${VAR:?…}` from the shell and `--env-file` only, **never** from a service's `env_file:`. Without the flag a value set only in `.env.production` reads as missing and the parse fails. `x deploy` passes it on every step (`packages/cli/src/cmd-deploy.ts`, `PROD_ENV_FILE`); a variable set in the shell still wins |
| `scheduler` and `replicator` at 1 replica | leader lock makes a second one a standby, not throughput |
| `stop_grace_period` >= `DRAIN_TIMEOUT` | otherwise SIGKILL truncates the drain and the reconnect fanout |
| Health probes from `/readyz` | never from a TCP check — a process can accept sockets while unable to serve |

`x deploy --method compose` applies this against the committed `docker/docker-compose.prod.yml`; it is a plain compose file you can read, diff, and run by hand — from the app root, as `docker compose --env-file .env.production -f docker/docker-compose.prod.yml up -d`.

> **`web` and `sync` are one replica each, and the file says so** `As of 2026-08`. Both publish a host port, one host port has exactly one binder, so both declare `replicas: 1` — a ceiling that is declared rather than discovered when the second container dies on `port is already allocated`. `worker`, `scheduler` and `replicator` publish nothing; `worker` scales freely.
>
> | Want | Do |
> |---|---|
> | more `web`/`sync` on the same box | delete their `ports:` lines, add a reverse proxy of your choosing to the compose file, point it at the service names — compose DNS resolves each to every replica |
> | more `web`/`sync`, full stop | the Helm chart below, which carries a per-role HPA and an Ingress |
>
> The framework ships neither proxy: a proxy image in `docker-compose.prod.yml` is a dependency every app inherits and a second answer to "how does traffic reach a role" beside the chart's Ingress. This is the rung-1 ceiling → [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md).

## Helm

**`x new` writes it**, `As of 2026-08-19` — `docker/helm`, one `Deployment` per role, 8 files: `Chart.yaml`, `values.yaml` and 6 templates. There is still no `--helm` flag on `x build`; the chart is a scaffold artifact like `docker/Dockerfile`, not a build target.

| Role | HPA metric | Typical range | Notes |
|---|---|---|---|
| `web` | requests/sec (or CPU as fallback) | 3–50 | behind Ingress + CDN; `terminationGracePeriodSeconds` >= drain |
| `sync` | **active WS connections** (custom metric) | 2–100 | no session affinity; connection count is the only honest signal |
| `worker` | **queue depth** per named queue (custom metric) | 2–200 | one Deployment per queue when isolation matters |
| `scheduler` | none — `replicas: 1` | 1 | `PodDisruptionBudget` maxUnavailable 1, leader lock covers overlap |
| `replicator` | none — `replicas: 1` | 1 | `StatefulSet`-shaped for stable identity; owns the slot |
| `migrate` | n/a | — | pre-install/pre-upgrade `Job` hook; blocks the release on failure |

CPU autoscaling is wrong for `sync` and `worker`: a node holding 80k idle sockets is near-zero CPU and near-capacity, and a worker blocked on a slow HTTP call is idle CPU with a growing backlog. The framework **declares** both series — `connections` and `queue_depth`, with `rps` derived from the monotonic `http_requests_total` — and `SCALING_METRICS` maps each role's signal to its series so the chart and the role table cannot drift. `As of 2026-08` every role serves `/metrics` on `METRICS_PORT` (default 9090) and `http`/`realtime`/`jobs` call the recorders, so the signals exist. **The chart's half is closed in 2.0.0**: `values.yaml` declares `metricsPort: 9090`, `_helpers.tpl` emits a container port named `metrics` on every role but `migrate`, `service.yaml` publishes it by name and `templates/servicemonitor.yaml` ships the scrape target. Two things remain, and neither is the chart's: `serviceMonitor.enabled` defaults **false**, because a cluster without the Prometheus operator has no such CRD and `helm install` would fail on an unknown kind; and turning scraped series into the `Pods` metrics an HPA reads needs a **custom-metrics adapter**. Do not hand-add a metrics container port — the chart already emits one and a duplicate is rejected by the API server → [Observability](Observability).

`x deploy --method helm` works in a fresh app `As of 2026-08-19`: the command implements helm
completely and its `X_NOT_IMPLEMENTED` branch — which claimed the *build* did not implement it, over
a build that did — is deleted. An app that deleted its chart now gets helm's own error.

The framework repo's own [`docker/helm`](https://github.com/developerz-ai/ultimate/tree/main/docker/helm)
carries two templates the scaffold does not — `pdb.yaml` and `servicemonitor.yaml`. Neither ships in
an npm tarball, so taking them is a `git clone` of this repo. On 3.0.0 and below, `x new` writes no
chart at all and `--method helm` exits `X_NOT_IMPLEMENTED`: copy the chart in, or use
`--method compose`.

## Behind a proxy — `TRUSTED_PROXY_HOPS`

`TRUSTED_PROXY_HOPS` counts the proxies that **append** to `x-forwarded-for` between the client and
`web`/`sync` → [Configuration](Configuration). Unset trusts no proxy header. Proxies treat the two
headers differently, and the reader follows that:

| Header | What proxies do | What the framework reads |
|---|---|---|
| `x-forwarded-for` → `ctx.ip` | **append** their peer (nginx `$proxy_add_x_forwarded_for`, an ALB, Envoy) | the entry `hops` from the right. A shorter list is not the declared chain: nothing is trusted and the socket address is used |
| `x-forwarded-proto` → `ctx.https` (HSTS, the CSRF self-origin) | usually **overwrite** (nginx `$scheme`, an ALB, Traefik); some append | a full list: the entry `hops` from the right. A **shorter** list: its first entry — an overwrite erased what the client sent, so what is left was written by a trusted hop |

As of 2026-10, two hops with an overwriting proto proxy read `https`, so HSTS goes out. Before, a
one-entry proto header behind `TRUSTED_PROXY_HOPS=2` counted as "not the chain": `ctx.https` was
false and no HSTS was sent.

**Make sure at least one trusted hop writes `x-forwarded-proto`.** If none does, the client's own
value reaches the app, exactly as it always has with `TRUSTED_PROXY_HOPS=1`. The edge that ends TLS
is the one to set it: nginx `proxy_set_header X-Forwarded-Proto $scheme;`. An inner proxy reached
over plain http must pass the edge's value on rather than writing its own `$scheme` — on
ingress-nginx, `use-forwarded-headers: "true"`.

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

Redeploy the previous image tag. The last **3** builds' assets stay served — `retentionPlan(deploys, keep = 3)`, a count of deploys with no time component and no `pwa.retention` config field — so a rollback one release back does not 404 anyone mid-session. Version-skew handling: [Upgrading](Upgrading). Failure symptoms: [Troubleshooting](Troubleshooting).
