# docker

One image, every role. `ROLE` selects behaviour at start, so there is one artifact to promote and
nothing to rebuild between staging and production.

| Role | Does | Listens |
|---|---|---|
| `web` | HTTP: pages, actions, assets | `$PORT` (default 3000) |
| `sync` | websockets for live queries | `$PORT + 1` |
| `worker` | the job queue | — |
| `scheduler` | cron tasks; leadership is an expiring lease row in `x_scheduler_leader` | — |
| `replicator` | the logical replication slot, exactly one per database | — |
| `migrate` | applies pending migrations and **exits** | — |

Every serving role answers `/healthz` and `/readyz`. `/readyz` flips to 503 on `SIGTERM` before the
socket closes, which is what makes a rolling restart drain instead of drop.

## Build and run

```sh
x build --target docker --tag docs-site:dev
docker run --rm -e ROLE=migrate -e DATABASE_URL=postgres://... docs-site:dev
docker run -p 3000:3000 -e DATABASE_URL=postgres://... docs-site:dev
```

The image build runs `x build --target prebuilt` after `COPY . .`: every island chunk and every
compiled stylesheet is made once, there, by the image's own Bun — so a pod builds nothing at boot.
Without that line every boot runs Babel and Sass over the whole app and logs
`X_IMAGE_NOT_PREBUILT`, naming it.

### What the image leaves out

`docker/Dockerfile.dockerignore` drops `*.test.ts`, `*.test.tsx` and the root `docs/`: no boot
reads them, and an edit to one leaves the prebuilt layer cached. An app that serves a file from
`docs/` re-includes it with `!docs/<path>`, on a line after `docs`.

## One box, every role

```sh
docker compose --env-file .env.production -f docker/docker-compose.prod.yml up -d   # db → migrate → the rest
x deploy --image docs-site:dev --dry-run --json           # the same plan, printed
```

`web` and `sync` publish a host port, so both sit at `replicas: 1`: one host port has exactly one
binder, and a second container dies on `port is already allocated`. `worker` publishes nothing and
scales freely. To scale the two serving roles on one box, delete their `ports:` lines and put your
own proxy on the compose network. To scale them properly, use an orchestrator — see below.

## The other two build targets

```sh
x build --target static --out dist/static   # one HTML file per `render: 'static'` route
x build --target binary --out dist/app      # a single executable, no Bun install needed
```

The binary bundles neither the framework nor the app: it is a launcher. `@ultimat3/*` stays
external and loads from the app's own `node_modules`, the app's `package.json` and
`tsconfig.json` are read at run time, and the registries are filled by scanning
`apps/*/{site,app,api,shared}` at boot. So it must be **started from the app root**, with the
source tree and an installed `node_modules` beside it. The image is the self-contained artifact.

## A PaaS (Heroku, Render, Fly, Railway, Cloud Run, App Runner…)

The framework ships **no** platform primitives — no buildpack, no `app.json`, no `fly.toml`, no
adapter. It does not need to: every one of these platforms builds a Dockerfile and every one of
them expects the same three things, which this image already does.

| The platform does | The image does |
|---|---|
| injects `PORT` and routes traffic to it | `apps/web/server.ts` binds exactly `$PORT`, refusing a value that is not a port (`X_PORT_INVALID`) rather than defaulting past it |
| requires the process to bind `0.0.0.0` | it binds every interface; loopback would be unreachable from outside the container |
| polls a health path | `/readyz` for "may I have traffic", `/healthz` for "am I alive" |
| sends `SIGTERM`, then `SIGKILL` after a grace period | drains in three phases: stop accepting, finish in-flight, close |

Set `DATABASE_URL` and deploy the Dockerfile. That is the whole integration.

### Release-phase migrations — the one way

Run **the same image** with `ROLE=migrate` before the new release serves traffic. It applies every
pending migration in `packages/db/migrations` under a Postgres advisory lock, records each in the
`x_migrations` ledger with its checksum, and exits 0. Concurrent migrators serialise; a checksum
that no longer matches an applied migration stops the release instead of corrupting it.

| Platform | Where the command goes |
|---|---|
| Heroku | `release: bun apps/web/server.ts` in `Procfile`, with `ROLE=migrate` on the release dyno |
| Render | `preDeployCommand: ROLE=migrate bun apps/web/server.ts` |
| Fly.io | `[deploy] release_command = "bun apps/web/server.ts"` with `ROLE=migrate` |
| Railway | a pre-deploy command running the same |
| Kubernetes | an `initContainer` or a `Job` on the same image with `ROLE=migrate` |
| Compose | the `migrate` service; every other role waits on `service_completed_successfully` |

There is no `x db migrate` in that list on purpose: it is the developer's command and it needs the
toolchain, while the release phase runs the shipped image and nothing else.

### One-off commands need a new entrypoint, not arguments

`ENTRYPOINT` is `bun apps/web/server.ts`, and that entry reads `ROLE` and `PORT` and **nothing
else** — argv never reaches a parser. So arguments appended to it are discarded in silence:

```sh
docker run docs-site:dev db backfill --all --write     # serves ROLE=web, forever
docker run --entrypoint bun docs-site:dev node_modules/@ultimat3/cli/src/bin.ts db backfill --all --write --json
```

The `backfill` service in `docker-compose.prod.yml` is the second form. A Kubernetes `Job` running
a one-off command sets `command:` (the entrypoint) as well as `args:`, for the same reason.

## Environment

| Key | Meaning | Unset means |
|---|---|---|
| `ROLE` | which process this is | `web` |
| `PORT` | the port the web role binds | 3000 |
| `DATABASE_URL` | Postgres | embedded PGlite — never in production |
| `BUILD_ID` | the immutable build hash clients are served against | computed from the manifest at boot |
| `NATS_URL` | multi-node realtime transport | in-process fanout, single node only |
| `S3_ENDPOINT` | object storage | a local directory |

## Kubernetes

```sh
x deploy --method helm --image ghcr.io/you/docs-site:1.2.3 --dry-run --json   # the plan
x deploy --method helm --image ghcr.io/you/docs-site:1.2.3                    # run it
```

One `helm upgrade --install` against `docker/helm`, which is scaffolded beside this file for the
same reason `docker-compose.prod.yml` is: a deploy method whose topology file only exists in
somebody else's repository is a command that cannot run. `--image` sets `image.repository` and
`image.tag`; everything else is `docker/helm/values.yaml`, and it is yours to edit.

| Object | Per | Note |
|---|---|---|
| Deployment + Service | enabled role | one image, `ROLE` and the port are the only difference |
| Job | release | `ROLE=migrate`, a `pre-install,pre-upgrade` hook — it runs to completion first |
| Ingress | release | off by default; routes `/_x/sync` to sync and `/` to web |
| HorizontalPodAutoscaler | role, opt-in | rps, websocket connections, queue depth — never CPU |
| ServiceMonitor | release | scrapes `/metrics` on `metricsPort`, every serving role |
| PrometheusRule | release | stalled queue, dead letters, lost leases, dropped frames, 5xx share, target down |

The last two render only where the cluster serves the Prometheus operator's kinds
(`serviceMonitor.enabled` and `alerts.enabled` are `auto`), so `helm install` still succeeds on a
cluster without it; `true` forces them, `false` declines. Each rule's threshold, `for` and
severity are values under `alerts.rules.<alert>`. Outside Kubernetes, `x g chart-alerts --print`
prints the same rules for any Prometheus rule loader. No PodDisruptionBudget: that is cluster
policy rather than this app's topology.
