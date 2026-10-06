# 🛠️ Ultimate — operations

Start on the smallest rung that holds your traffic. Climb only on a signal, never on a feeling.

**Axiom 7 is the frame: deploy anywhere = containers only.** `x build --target docker` emits one
image with six roles. Nothing below is a framework dependency — ArgoCD, sealed-secrets, Prometheus,
cert-manager, CloudNativePG, Dragonfly and NATS are *recommendations*, and every one of them is
replaceable without touching a line of app code. If your platform already answers a concern, use
its answer.

## Where the knowledge comes from

| Source | Trust it for |
|---|---|
| This repo's [`docker/`](../../docker/README.md) | what Ultimate actually ships — Dockerfile, compose files, Helm chart |
| An operator running this stack in production (`As of 2026-08`) | resource numbers, failure modes, alert thresholds, runbook steps |
| Marked **not yet implemented** | a thing the docs below describe that Ultimate does not emit today |

Every resource number in [`04-datastores.md`](./04-datastores.md) is a real production value, not a
guess. Every failure mode in [`06-runbooks.md`](./06-runbooks.md) happened to somebody.

## The ladder

Rung numbers are [`../idea/17-scale-ladder.md`](../idea/17-scale-ladder.md)'s — that doc is the canonical ladder and this one does not renumber it. Its five rungs collapse to the three shapes an operator actually runs: rungs 0 and 1 are the same platform with one service or several, so they are one row here, and rung 4 is rung 3 plus datastores.

| Rung | You run | You deploy by | Costs you |
|---|---|---|---|
| **0–1 — PaaS** | one container per role on a managed platform, managed Postgres | pushing an image; the platform restarts | per-process pricing, and whatever datastore the platform does not sell |
| **2 — one box + Compose** | [`docker-compose.prod.yml`](../../docker/docker-compose.prod.yml), Postgres and NATS beside it or managed | `x deploy` (or `ssh` + the same `docker compose` lines) | the box is the availability story. `x deploy` rolls every role that can run two containers **start-first**; a role publishing a host port (the shipped `web`, `sync`) cannot, and restarts with a gap until a proxy fronts it — below |
| **3 — Kubernetes** | the Helm chart or the manifest set in [`01-kubernetes.md`](./01-kubernetes.md) | `git push` (GitOps) | a control plane, a secrets story, an on-call story |

**You are on a PaaS or one box until something on this list is true.** Not before. A first app and a product with paying users are the same deployment — rung 0 is a free plan with no card — and the range that spans, small end to very large, is [`../idea/21-the-range.md`](../idea/21-the-range.md).

| Climb to Compose (rung 2) when | Climb to Kubernetes (rung 3) when |
|---|---|
| you need NATS, object storage or a Postgres extension the platform does not sell | one machine cannot hold peak, and vertical growth has run out |
| the platform's build step cannot build your image, so you are fighting buildpacks | a deploy is user-visible and that now costs you money |
| per-role scaling on the platform costs more than a box | you need more than one machine for availability, not for capacity |
| — | you need a migration to gate traffic rather than race it |

Rung 2's real ceiling, `As of 2026-08`: the shipped prod compose publishes static host ports
(`3000:3000`, `3001:3001`) for `web` and `sync`. Two processes cannot bind one host port, so both
services declare `replicas: 1` — the file says what it does, rather than declaring 3 and starting 1.
`worker` has no published port and scales freely.

**How `x deploy --method compose` rolls a serving role** (`As of 2026-10-05`,
[`packages/cli/src/cmd-deploy-compose.ts`](../../packages/cli/src/cmd-deploy-compose.ts)). Read off
the compose file per role, and reported per step in `x deploy --dry-run --json` (`strategy`, `why`):

| The service | Strategy | What runs |
|---|---|---|
| publishes no fixed host port, sets no `container_name`, not `network_mode: host` — the shipped `worker`, `scheduler` | **start-first** | `docker compose ps -q <role>` lists the running containers and compose's config hash splits them into those already on the new definition and the stale rest; `up -d --no-deps --no-recreate --wait --wait-timeout 300 --scale <role>=<running + shortfall> <role>` starts only the missing new ones **beside** them and waits for their healthcheck; then `docker stop` (SIGTERM, then `stop_grace_period`) and `docker rm` the stale ones and any surplus beyond `replicas` (oldest first). So a rerun after a half-finished deploy finishes it instead of adding replicas. A new container that never turns healthy is stopped and removed, the old keep serving, and the deploy fails `X_DEPLOY_FAILED` naming the sub-command — and, when that cleanup fails too, the `docker stop`/`rm` line and the containers it left running |
| publishes a host port (`3000:3000`, `127.0.0.1:3001:3001`, long-form `published:`) — the shipped `web`, `sync` | **stop-first** | `up -d <role>`: compose recreates the container, so the role serves nothing between the old one's exit and the new one's healthcheck |

`deploy.update_config.order: start-first` is a Swarm field `docker compose` ignores, which is why the
sequence is `x deploy`'s own. **The proxy requirement:** to roll `web` and `sync` start-first, delete
their `ports:` lines and put a reverse proxy on the compose network that routes to the service
names and **retries a refused connection on another upstream** — compose DNS resolves a service name
to every replica, so during a roll it returns the old and the new container, and the old one stops
accepting the instant its readiness grace ends. The proxy publishes the host port instead.

Two ways past it, in order of cost:

| Want | Do |
|---|---|
| more `web`/`sync` on the same box, and start-first deploys for them | delete their `ports:` lines, add a reverse proxy of your choosing to the compose file, point it at the service names — compose DNS resolves each to every replica, and `x deploy` then rolls both start-first |
| more `web`/`sync`, full stop | climb to rung 3; `docker/helm` already carries a per-role HPA and an ingress |

**Set `SYNC_URL` on this rung**, shipped in 21.0.0. A page's one socket dials
`/_x/sync` on the page's own origin unless `SYNC_URL` says otherwise
(`packages/cli/src/sync-url.ts`). Here `web` answers on 3000 and `sync` on 3001, with nothing in
front to route between them, so write `SYNC_URL=ws://<host>:3001/_x/sync` (or `wss://`) into
`.env.production`. The shipped compose file makes it required (`${SYNC_URL:?…}`), and Compose
fills that from the shell and `--env-file` only, never from `env_file:`: run
`docker compose --env-file .env.production -f docker/docker-compose.prod.yml up -d`, as `x deploy`
does. Without the value, Compose refuses to start `web`. A value that is not `ws:`/`wss:` is `X_CONFIG_INVALID` at boot. Add a reverse proxy
that routes `/_x/sync` to `sync`, and the default works with no variable.

**And `APP_URL`**, the origin the pages are served on (`http://<host>:3000` here). The sync node
admits a websocket from `APP_URL`'s origin and no other once one is declared (scheme, host and
port exactly); with none declared, from the origin it was reached on. On this rung the page and
the socket are two origins: without it every upgrade is `403 X_SOCKET_ORIGIN_REFUSED`. The shipped
compose file requires it on `sync` the same way (`${APP_URL:?…}`). A PaaS serving both on one host
needs none: the node admits the `https` spelling of the host and port it was reached on. Rung 3's
chart sets `APP_URL` on the sync role from `ingress.host`.

The framework ships neither proxy. A proxy image in `docker-compose.prod.yml` would be a dependency
every app inherits and a second answer to "how does traffic reach a role" beside the chart's
Ingress — [`../idea/18-build-vs-wrap.md`](../idea/18-build-vs-wrap.md)'s bar, not cleared.

**Do not skip rungs to look serious.** A Kubernetes cluster you run for one app is a second product
to maintain. The operator whose scars fill these docs runs many apps on one cluster — that is what
pays for the control plane.

## Read in this order

| Doc | Answers |
|---|---|
| [`01-kubernetes.md`](./01-kubernetes.md) | the exact manifests an Ultimate app needs, and how GitOps applies them |
| [`02-secrets.md`](./02-secrets.md) | how a secret reaches a pod without ever being committed in plaintext |
| [`03-observability.md`](./03-observability.md) | what to scrape, what to alert on, what Ultimate does not emit yet |
| [`04-datastores.md`](./04-datastores.md) | Postgres, Dragonfly and NATS in production — real sizing, real failure modes |
| [`05-disaster-recovery.md`](./05-disaster-recovery.md) | backups you can restore, and the key without which they are noise |
| [`06-runbooks.md`](./06-runbooks.md) | rollback, stuck deploys, image-pull failures, a leaked credential |

## What Ultimate ships today

| Artifact | State `As of 2026-08` |
|---|---|
| [`docker/Dockerfile`](../../docker/Dockerfile) | **this repo's own** CLI image: multi-stage → `distroless/cc-debian13:nonroot`, one compiled binary, no shell, 184 MB (`docker images`, linux/amd64 — `/app/x` alone is 92 MB, because `--compile` bakes the Bun runtime in) |
| the Dockerfile `x new` writes you | **not the same image.** `oven/bun:1.4-alpine`, `ENTRYPOINT ["bun", "apps/web/server.ts"]`, `USER 1000:1000` — the base image's `bun` user, numeric so a kubelet can check it against `runAsNonRoot` (`RUNTIME_UID`, [`scaffold-helm.ts`](../../packages/cli/src/templates/scaffold-helm.ts)), measured 194MB (`As of 2026-08`). It has a shell; the framework's image does not |
| the chart `x new` writes you (`docker/helm/` in the app) | runs every pod as `runAsUser`/`runAsGroup`/`fsGroup: 1000`, the same `RUNTIME_UID` its Dockerfile's `USER` reads, so the two cannot drift (`As of 2026-10`). **This repo's** chart runs `65532`, distroless `nonroot` — correct for its own image only. Copy neither number into the other |
| `x build --target binary` | a **launcher**, not a self-contained app (`As of 2026-10`): `bun build --compile` with `--compile-autoload-package-json`, `--compile-autoload-tsconfig` and `--external '@ultimat3/*'` (`binaryArgs`, [`cmd-build.ts`](../../packages/cli/src/cmd-build.ts)). Started inside the app tree it imports `app.config.ts` and `apps/*` off disk, so it needs that tree — `package.json`, `tsconfig.json`, and `node_modules` beside it. It needs no Bun installed: the runtime is compiled in. `docker/Dockerfile`'s `/app/x` is a different, self-contained compile of the CLI |
| `.github/workflows/image.yml` `x new` writes you | after a green `ci` on the default branch (a `push`, never a fork's pull request), builds the app's `docker/Dockerfile` and pushes `ghcr.io/<owner>/<repo>:sha-<7>` and `:<full sha>` — never `latest` — with `GITHUB_TOKEN` alone. Always `runs-on: ubuntu-latest` (it needs bash and a Docker daemon), even when `ci.yml` runs on `vars.CI_RUNNER`. It deploys nothing: the digest is the handoff ([`image.yml.ts`](../../packages/cli/src/templates/github/image.yml.ts)) |
| [`docker/docker-compose.prod.yml`](../../docker/docker-compose.prod.yml) | one service per role, `migrate` gates `web` via `service_completed_successfully`; `web` and `sync` at `replicas: 1`, `worker` free |
| [`docker/helm/`](../../docker/helm/) | per-role Deployments with a `startupProbe`, per-role HPAs, a `pre-install,pre-upgrade` migrate Job running as its own hook-created ServiceAccount (so a first `helm install` cannot wait on an account Helm has not made yet), an optional Ingress |
| `/healthz` and `/readyz` on `web` and `sync` | shipped — [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts). `worker`, `scheduler` and `replicator` open no HTTP socket; their only port is `/metrics` ([`01-kubernetes.md`](./01-kubernetes.md)) |
| SIGTERM drain on every role | shipped — see [`../architecture/13-topology-runtime.md`](../architecture/13-topology-runtime.md) |
| OTel-shaped tracing | **shipped, and exportable** — `otlpSpanExporter()` speaks OTLP/HTTP JSON to `OTEL_EXPORTER_OTLP_ENDPOINT`, head-based sampling included. The default stays a no-op, so nothing leaves the process until you wire it. gRPC `:4317` is refused; use the collector's `:4318`. No logs signal |
| `/metrics` on any role | **shipped** — `METRICS_PATH` on `METRICS_PORT` (default 9090), never the app port. The chart declares the `metrics` containerPort on every role but `migrate`, publishes it on the Service, and ships a ServiceMonitor behind `serviceMonitor.enabled` (off by default: a cluster with no Prometheus operator has no such CRD) |
| a custom-metrics adapter | **never shipped** — the chart's per-role HPAs target `rps` and `connections` as `Pods` metrics and `queue_depth` as an `External` one (every worker publishes the same global backlog, so it is one series for the fleet — expose it as `max`, never `sum`), and turning scraped series into those is the cluster's job, not the framework's |
| `x logs` | listed as **planned** in `x --help` |

That adapter row is load-bearing for [`03-observability.md`](./03-observability.md): the app emits
the three signals and the chart exposes them, but an HPA with no metrics adapter behind it still
sits at `<unknown>` and never scales. Install the adapter before enabling autoscaling.
