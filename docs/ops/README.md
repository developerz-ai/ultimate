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
| **2 — one box + Compose** | [`docker-compose.prod.yml`](../../docker/docker-compose.prod.yml), Postgres and NATS beside it or managed | `ssh` + `docker compose up -d` | the box is the availability story; a deploy is visible |
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

Two ways past it, in order of cost:

| Want | Do |
|---|---|
| more `web`/`sync` on the same box | delete their `ports:` lines, add a reverse proxy of your choosing to the compose file, point it at the service names — compose DNS resolves each to every replica |
| more `web`/`sync`, full stop | climb to rung 3; `docker/helm` already carries a per-role HPA and an ingress |

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
| [`docker/Dockerfile`](../../docker/Dockerfile) | **this repo's own** image: multi-stage → `distroless/cc-debian12:nonroot`, one compiled binary, no shell, ~80MB |
| the Dockerfile `x new` writes you | **not the same image.** `oven/bun:1.4-alpine`, `ENTRYPOINT ["bun", "apps/web/server.ts"]`, user `bun`, measured 194MB. Harden against *this* one — the uid and the shell differ, so the `runAsUser: 65532` baseline below does not transfer unchanged |
| [`docker/docker-compose.prod.yml`](../../docker/docker-compose.prod.yml) | one service per role, `migrate` gates `web` via `service_completed_successfully`; `web` and `sync` at `replicas: 1`, `worker` free |
| [`docker/helm/`](../../docker/helm/) | per-role Deployments, per-role HPAs, a `pre-install,pre-upgrade` migrate Job, an optional Ingress |
| `/healthz` and `/readyz` on every role | shipped — [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts) |
| SIGTERM drain on every role | shipped — see [`../architecture/13-topology-runtime.md`](../architecture/13-topology-runtime.md) |
| OTel-shaped tracing | **shipped, and exportable** — `otlpSpanExporter()` speaks OTLP/HTTP JSON to `OTEL_EXPORTER_OTLP_ENDPOINT`, head-based sampling included. The default stays a no-op, so nothing leaves the process until you wire it. gRPC `:4317` is refused; use the collector's `:4318`. No logs signal |
| `/metrics` on any role | **shipped** — `METRICS_PATH` on `METRICS_PORT` (default 9090), never the app port. The chart declares the `metrics` containerPort on every role but `migrate`, publishes it on the Service, and ships a ServiceMonitor behind `serviceMonitor.enabled` (off by default: a cluster with no Prometheus operator has no such CRD) |
| a custom-metrics adapter | **never shipped** — the chart's per-role HPAs target pod metrics (`rps`, `connections`, `queue_depth`), and turning scraped series into those is the cluster's job, not the framework's |
| `x logs` | listed as **planned** in `x --help` |

That adapter row is load-bearing for [`03-observability.md`](./03-observability.md): the app emits
the three signals and the chart exposes them, but an HPA with no metrics adapter behind it still
sits at `<unknown>` and never scales. Install the adapter before enabling autoscaling.
