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
x build --target docker --tag social-media-clone:dev
docker run --rm -e ROLE=migrate -e DATABASE_URL=postgres://... social-media-clone:dev
docker run -p 3000:3000 -e DATABASE_URL=postgres://... social-media-clone:dev
```

The image build runs `x build --target prebuilt` after `COPY . .`: every island chunk and every
compiled stylesheet is made once, there, by the image's own Bun — so a pod builds nothing at boot.
Without that line every boot runs Babel and Sass over the whole app and logs
`X_IMAGE_NOT_PREBUILT`, naming it.

## One box, every role

```sh
docker compose --env-file .env.production -f docker/docker-compose.prod.yml up -d   # db → migrate → the rest
x deploy --image social-media-clone:dev --dry-run --json           # the same plan, printed
```

`--env-file .env.production` is not optional: Compose fills `${SYNC_URL:?…}`, `${APP_URL:?…}` and
`${POSTGRES_PASSWORD:?…}` from the shell and `--env-file` only, never from `env_file:`, so without it
a value set in `.env.production` reads as missing and the parse fails. `x deploy` passes it on every step.

## The other two build targets

```sh
x build --target static --out dist/static   # one HTML file per `render: 'static'` route
x build --target binary --out dist/app      # a single executable carrying the Bun runtime
```

The binary bundles neither the app nor the framework: `@ultimat3/*` stays external, and at run
time both are resolved from the app tree — its `package.json`, its `tsconfig.json` and its
installed `node_modules` — while the registries are filled by scanning
`apps/*/{site,app,api,shared}` at boot. So it is a launcher that must be **started from the app
root**, with the installed source tree beside it. The image is the self-contained artifact.

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

`x new <app>` generates an app-specific chart under `docker/helm/`, including `Chart.yaml`,
`values.yaml` and the workload templates. The chart is a scaffold artifact, not an `x build` target.

Deploy from the app root with a tagged image available to the cluster:

```sh
x deploy --method helm --image registry.example.com/social-media-clone:1.0.0 --json
```

`--image` becomes `--set-string image.repository=registry.example.com/social-media-clone` and
`--set-string image.tag=1.0.0`. Both stay strings, including all-digit tags. An untagged reference
sets only `image.repository`, leaving the tag to default to the chart's `appVersion`.

The deploy reads `app.config.ts`'s `drain` config and passes `drain.deadlineSeconds` and
`drain.readinessGraceSeconds` to Helm from `deadlineMs` and `readinessGraceMs`, rounded up to
seconds; readiness grace is at least the production default. When `workerDeadlineMs` is declared,
it also passes `drain.workerDeadlineSeconds` for the worker's own budget. The chart derives each
role's `terminationGracePeriodSeconds` from these values and its margins, so a raised drain budget
raises the termination grace too.

The framework repository's `docker/helm/templates/` additionally contains `pdb.yaml` and
`servicemonitor.yaml`. These two templates are framework-only: neither is generated by `x new`
nor included in npm tarballs. Take them from a clone of the framework repository if needed.

**Historical fallback — versions 3.0.0 and below only:** `x new` generated no chart and
`--method helm` exited `X_NOT_IMPLEMENTED`. For those versions, copy in the framework chart for
manual Helm use, or use `x deploy --method compose`.

See the [deployment manual](../../../wiki/Deployment.md#helm) for the Helm topology and values.
