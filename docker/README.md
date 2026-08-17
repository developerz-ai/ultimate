# 🐳 docker

**Deploy anywhere = containers only.** Zero platform primitives in the framework: no vendor KV, no
edge runtime, no proprietary queue, no build-plugin lock-in. If it runs containers, it runs
Ultimate — a laptop, a single VPS, ECS, Nomad, Kubernetes, a Raspberry Pi.

## One image, N roles

Build once. `ROLE` selects behaviour at start; nothing else differs between processes.

| Role | Scales on | HTTP | Metrics | Probe |
|---|---|---|---|---|
| `web` | RPS | `:3000` | `:9090` | `/readyz` + `/healthz` on `:3000` |
| `sync` | concurrent websockets | `:3001` | `:9090` | `/readyz` + `/healthz` on `:3001` |
| `worker` | queue depth | — | `:9090` | liveness on `/metrics` |
| `scheduler` | fixed 1 (advisory-lock leader election) | — | `:9090` | liveness on `/metrics` |
| `replicator` | 1 per database | — | `:9090` | liveness on `/metrics` |
| `migrate` | run-once, pre-deploy | — | — | none — it exits |

**Only `web` and `sync` serve `/healthz` and `/readyz`**; the other three open no HTTP socket at all
(`packages/cli/src/metrics-endpoint.ts`), and the scrape listener is the only port they have. This
file claimed "every role" until 2026-08, which is the same wrong assumption that made `sync`'s
readiness probe poll a port the process never opened. Every role drains on `SIGTERM`, and the drain
is bounded at `DEFAULT_DEADLINE_MS` — 25s — so a `stop_grace_period` or a
`terminationGracePeriodSeconds` below that is a SIGKILL on a process that was about to exit cleanly.

## Files

| File | For |
|---|---|
| `Dockerfile` | multi-stage → distroless, non-root, 189MB, one binary, no shell |
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

Every port in that file binds `127.0.0.1`. The credentials are in the file, so the short
`'5432:5432'` form put an open Postgres and an open MinIO on every interface the laptop had —
and Docker publishes ports with DNAT rules, which a host firewall does not see. To reach the stack
from another machine, tunnel to it (`ssh -L 5432:localhost:5432 …`) rather than widening the bind.

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
| `manifests` | every workspace `package.json` in the context and nothing else — derived, so a new workspace glob cannot be forgotten |
| `deps` | `bun install --frozen-lockfile` over those manifests, cached across code changes |
| `build` | `bun build --compile` → one self-contained binary |
| `runtime` | `distroless/cc-debian13:nonroot` + the binary. No Bun, no npm, no shell |

`cc` rather than `base`: a Bun single-file executable links against `libstdc++`. **`debian13`, and
the digit is load-bearing** — it must be the same Debian as the build stage (`oven/bun:1.3-slim`,
trixie). The build stage was `oven/bun:1.3-alpine` until 2026-08, so the binary asked for
`ld-musl-x86_64.so.1` on a glibc-only runtime and *every container this image started* died with
`exec /app/x: no such file or directory`. The runtime stage now ends in
`RUN ["/app/x", "--version"]` — exec form, because distroless has no shell — so that class of
failure is a red build rather than a red pod.

`As of 2026-08`, linux/amd64: `/app/x` is 104MB (`--compile` bakes in the Bun runtime) and the image
is 189MB (`docker images`). The "roughly 80MB" this file claimed was never true of any build.
