# 🐳 docker

**Deploy anywhere = containers only.** Zero platform primitives in the framework: no vendor KV, no
edge runtime, no proprietary queue, no build-plugin lock-in. If it runs containers, it runs
Ultimate — a laptop, a single VPS, ECS, Nomad, Kubernetes, a Raspberry Pi.

## One image, N roles

Build once. `ROLE` selects behaviour at start; nothing else differs between processes.

| Role | Scales on | Listens |
|---|---|---|
| `web` | RPS | `:3000` |
| `sync` | concurrent websockets | `:3001` |
| `worker` | queue depth | — |
| `scheduler` | fixed 1 (advisory-lock leader election) | — |
| `migrate` | run-once, pre-deploy | — |
| `replicator` | 1 per database | — |

Every role serves `/healthz` and `/readyz` and drains on `SIGTERM`.

## Files

| File | For |
|---|---|
| `Dockerfile` | multi-stage → distroless, non-root, ~80MB, one binary, no shell |
| `docker-compose.dev.yml` | optional local Postgres + NATS + MinIO |
| `docker-compose.prod.yml` | the production topology: one service per role, one box |
| `helm/` | Kubernetes chart with **per-role HPAs** — where `web` and `sync` actually scale out |

## Local

`x dev` needs none of this — embedded Postgres (PGlite), in-process events, S3 to a local
directory. Use compose only when you want the real services:

```sh
docker compose -f docker/docker-compose.dev.yml up -d
DATABASE_URL=postgres://ultimate:ultimate@localhost:5432/ultimate x dev
```

## Build and run

```sh
x build --target docker --tag ghcr.io/you/app:1.2.3
docker run -e ROLE=worker -e DATABASE_URL=... ghcr.io/you/app:1.2.3
```

## Production

```sh
IMAGE=ghcr.io/you/app:1.2.3 docker compose -f docker/docker-compose.prod.yml run --rm migrate
IMAGE=ghcr.io/you/app:1.2.3 docker compose -f docker/docker-compose.prod.yml up -d
```

`web` and `sync` publish a host port, so both sit at `replicas: 1`: one host port has exactly one
binder, and the second container dies on `Bind for 0.0.0.0:3000 failed: port is already allocated`.
`worker` publishes nothing and scales freely. To scale the two serving roles on one box, delete
their `ports:` lines and put your own proxy on the compose network — the service name resolves to
every replica. To scale them properly, climb to the chart.

```sh
helm upgrade --install app docker/helm \
  --set image.repository=ghcr.io/you/app --set image.tag=1.2.3
```

## Why per-role autoscaling

CPU is a lagging proxy for all three serving roles and scales the wrong one at the wrong time.

| Role | Metric | Because |
|---|---|---|
| `web` | requests/second | stateless SSR + RPC; latency degrades with request rate |
| `sync` | connections/pod | a websocket costs memory while idle; RPS says nothing about it |
| `worker` | queue depth | the only signal that predicts a backlog before it is user-visible |

## Image size

| Stage | Contains |
|---|---|
| `deps` | lockfile-only install, cached across code changes |
| `build` | `bun build --compile` → one self-contained binary |
| `runtime` | `distroless/cc-debian12:nonroot` + the binary. No Bun, no npm, no shell |

`cc` rather than `base`: a Bun single-file executable links against `libstdc++`. As of 2026-07 the
result is roughly 80MB.
