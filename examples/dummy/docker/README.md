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
x build --target docker --tag postly:dev
docker run --rm -e ROLE=migrate -e DATABASE_URL=postgres://... postly:dev
docker run -p 3000:3000 -e DATABASE_URL=postgres://... postly:dev
```

## One box, every role

```sh
docker compose -f docker/docker-compose.prod.yml up -d      # db → migrate → the rest
x deploy --image postly:dev --dry-run --json           # the same plan, printed
```

## The other two build targets

```sh
x build --target static --out dist/static   # one HTML file per `render: 'static'` route
x build --target binary --out dist/app      # a single executable, no Bun install needed
```

The binary bundles the framework, not the app: the registries are filled by scanning
`apps/*/{site,app,api,shared}` at boot, so it is a launcher that must be **started from the app
root**, with the source tree beside it. The image is the self-contained artifact.

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

`x deploy --method helm` expects a chart at `docker/helm`. `x new` does not write one — a chart is
a topology decision, not a scaffold default. Copy `docker/helm` from the framework repository, or
stay on `--method compose`.
