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

| Rung | You run | You deploy by | Costs you |
|---|---|---|---|
| **0 — PaaS** | one container per role on a managed platform, managed Postgres | pushing an image; the platform restarts | per-process pricing, and whatever datastore the platform does not sell |
| **1 — one box + Compose** | [`docker-compose.prod.yml`](../../docker/docker-compose.prod.yml), Postgres and NATS beside it or managed | `ssh` + `docker compose up -d` | the box is the availability story; a deploy is visible |
| **2 — Kubernetes** | the Helm chart or the manifest set in [`01-kubernetes.md`](./01-kubernetes.md) | `git push` (GitOps) | a control plane, a secrets story, an on-call story |

**You are on rung 0 or 1 until something on this list is true.** Not before.

| Climb 0 → 1 when | Climb 1 → 2 when |
|---|---|
| you need NATS, object storage or a Postgres extension the platform does not sell | one machine cannot hold peak, and vertical growth has run out |
| the platform's build step cannot build your image, so you are fighting buildpacks | a deploy is user-visible and that now costs you money |
| per-role scaling on the platform costs more than a box | you need more than one machine for availability, not for capacity |
| — | you need a migration to gate traffic rather than race it |

Rung 1's real ceiling, `As of 2026-08`: the shipped prod compose publishes static host ports
(`3000:3000`, `3001:3001`) for `web` and `sync`. Two processes cannot bind one host port, so those
roles are effectively single-instance on one box unless you drop the static publish and put a
reverse proxy in front. `worker` has no published port and scales freely.

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
| [`docker/Dockerfile`](../../docker/Dockerfile) | multi-stage → `distroless/cc-debian12:nonroot`, one compiled binary, no shell, ~80MB |
| [`docker/docker-compose.prod.yml`](../../docker/docker-compose.prod.yml) | one service per role, `migrate` gates `web` via `service_completed_successfully` |
| [`docker/helm/`](../../docker/helm/) | per-role Deployments, per-role HPAs, a `pre-install,pre-upgrade` migrate Job, an optional Ingress |
| `/healthz` and `/readyz` on every role | shipped — [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts) |
| SIGTERM drain on every role | shipped — see [`../architecture/13-topology-runtime.md`](../architecture/13-topology-runtime.md) |
| OTel-shaped tracing | shipped as a **seam**: spans exist, the default exporter is a no-op and no OTLP exporter ships |
| `/metrics` on any role | **not yet implemented** at the time of writing — a metrics seam is landing in `packages/core`; confirm what your build actually exposes before wiring a scrape |
| `x logs` | listed as **planned** in `x --help` |

That last row is load-bearing for [`03-observability.md`](./03-observability.md): the chart's per-role
HPAs target custom pod metrics (`rps`, `connections`, `queue_depth`). Confirm the framework emits
them, and that a custom metrics adapter is installed, before enabling autoscaling — an HPA with no
metric source sits at `<unknown>` and never scales.
