# Tutorial 5 — deploy on a free tier

The framework ships **no** platform primitives — no buildpack, no `app.json`, no `fly.toml`, no adapter. It does not need to: every PaaS builds a Dockerfile, and every one of them wants the same three behaviours the scaffolded image already has.

`As of 2026-08`. Every command and every output on this page was executed against a `create-ultimate@1.1.0` app and its own `docker/Dockerfile`, with Docker 28 on Linux.

Series: [1 — first app](Tutorial-01-First-App) · [2 — first feature](Tutorial-02-First-Feature) · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · **5** · [6 — growing up](Tutorial-06-Growing-Up)

## The whole integration

| The platform does | The image does |
|---|---|
| injects `PORT`, routes traffic to it | `apps/web/server.ts` binds exactly `$PORT`, refusing a non-port value with `X_PORT_INVALID` rather than defaulting past it |
| requires a bind on `0.0.0.0` | binds every interface — loopback is unreachable through a port mapping |
| polls a health path | `/readyz` for *may I have traffic*, `/healthz` for *am I alive* |
| sends `SIGTERM`, then `SIGKILL` | drains in three phases: stop accepting, finish in-flight, close |
| wants one artifact per release | one image, `ROLE` selects the process |

Set `DATABASE_URL`. Point the platform at `docker/Dockerfile`. That is the integration.

## Build

```bash
bunx x build --target docker --tag myapp:dev
```

```text
✓ built docker
```

```text
myapp:dev  194MB
```

`x build` runs the static gate steps first — `typecheck`, `lint`, `boundaries`, `filesize`, `package-shape`, `errors` — and exits non-zero without building if any fail. A build that would fail `x verify` produces no artifact.

The scaffolded image is `oven/bun:1.4-alpine`, runs as the non-root `bun` user, and its `ENTRYPOINT` is `["bun", "apps/web/server.ts"]`. There is no build stage and no second gate inside it: re-running `tsc` and `biome` there would need the devDependencies the `--production` install deliberately omits.

> `docs/ops/README.md` describes a distroless, single-binary, ~80MB image. That is not what `x new` writes at 1.1.0 — read the scaffolded [`docker/Dockerfile`](https://github.com/developerz-ai/ultimate/blob/main/docker/Dockerfile) as the authority.

## Run it, locally, exactly as the platform will

```bash
docker run -d --name myapp-web -e ROLE=web -e PORT=8080 -p 8085:8080 myapp:dev
```

```text
{"ts":"2026-08-11T17:12:04.499Z","level":"info","msg":"ultimate web listening on http://0.0.0.0:8080"}
{"ts":"2026-08-11T17:12:04.502Z","level":"info","msg":"ultimate started","role":"web","url":"http://0.0.0.0:8080","buildId":"ed71a3fe16aa534e"}
```

```bash
curl http://127.0.0.1:8085/readyz
```

```json
{"state":"ready","ready":true,"uptimeMs":11792,"inflight":0,"buildId":"","role":"web"}
```

The image's own `HEALTHCHECK` reports `healthy` within the 30s start period. Prove that locally before you debug it on a platform.

### The three env vars that matter

| Key | Unset means | Set it to |
|---|---|---|
| `ROLE` | `web` | `web` for the service, `migrate` for the release phase |
| `PORT` | 3000 | whatever the platform injects — leave it to the platform |
| `DATABASE_URL` | **embedded PGlite** — never in production | the managed Postgres connection string |

A real `DATABASE_URL` env var wins over anything baked into the image; verified by pointing a container at an unreachable host and getting `X_DB_UNAVAILABLE` rather than a silent PGlite fallback.

**No `.env` file reaches the image**, `As of 2026-08-19`. `docker/Dockerfile.dockerignore` excludes `**/.env` and `**/.env.*`, keeping only `!**/.env.example`. It did not: the old patterns were `.env` and `.env.*.local`, which match neither `.env.development` **nor `.env.production`** — the file `docker/docker-compose.prod.yml`'s `env_file:` tells you to create. Both shipped inside the layer, proven by a real `docker build`, and this tutorial called that harmless.

On 3.0.0 and below, add these three lines to `docker/Dockerfile.dockerignore` before your first build — and rebuild, because an image already built still carries them:

```text
**/.env
**/.env.*
!**/.env.example
```

## Release-phase migrations — the one way

Run **the same image** with `ROLE=migrate` before the new release serves traffic.

```bash
docker run --rm -e ROLE=migrate -e DATABASE_URL=postgres://… myapp:dev
```

```json
{"ts":"2026-08-11T17:12:23.681Z","level":"info","msg":"ultimate migrate applied","applied":3,"available":3,"appVersion":"dev"}
```

It applies every pending migration in `packages/db/migrations` under a Postgres advisory lock, records each in the `x_migrations` ledger with its checksum, and exits 0. Concurrent migrators serialise — the second waits up to 60s for the lock, then exits non-zero with `X_MIGRATE_CONCURRENT` rather than hanging the release; a checksum that no longer matches an applied migration stops the release rather than corrupting it.

| Platform | Where the command goes |
|---|---|
| Heroku | `release:` in `Procfile`, with `ROLE=migrate` on the release dyno |
| Render | a pre-deploy command running `ROLE=migrate bun apps/web/server.ts` |
| Fly.io | `[deploy] release_command` with `ROLE=migrate` |
| Railway | a pre-deploy command running the same |
| Kubernetes | an `initContainer` or a `Job` on the same image |
| Compose | the `migrate` service; every other role waits on `service_completed_successfully` |

**No release phase on your free tier?** Several platforms gate pre-deploy commands behind a paid plan. Run the one-off yourself against the same image and the same `DATABASE_URL` before promoting the release — that is what every row above ultimately is.

`x db migrate` is deliberately absent from that table: it is the developer's command, it needs the toolchain, and at 1.1.0 it is [broken in a scaffolded app](Tutorial-02-First-Feature#migrations) anyway. The release phase runs the shipped image and nothing else.

## What a free tier costs you

Free instances **sleep**. That is not a performance note; it changes which roles can exist.

| Role | On a single sleeping free instance |
|---|---|
| `web` | works. First request after a sleep pays a cold start, then serves normally |
| `worker` | **does not run reliably.** No inbound traffic means nothing wakes the instance, so queued jobs sit until the next visitor |
| `scheduler` | **does not run reliably.** A cron whose process is asleep at 03:00 does not fire then; `catchUp: 'skip'` is the generated default, so whenever something next wakes the instance a week of missed occurrences collapses into one late fire, never a replay of each |
| `sync` | works while awake; every sleep disconnects every subscriber |
| `replicator` | needs a Postgres with `wal_level=logical`, which free managed tiers generally do not offer |

Two honest options on rung 0:

| Option | Trade |
|---|---|
| ship `ROLE=web` only, do the work inline in the action | no durability, no retries — acceptable for work that is cheap and idempotent |
| ship `ROLE=web` and keep the jobs, accepting late execution | correct results, unpredictable latency. The queue is Postgres, so nothing is lost — only delayed |

Do not paper over it with an external pinger: keeping a free instance awake around the clock is what the free tier is not. The moment jobs must run on time, that is the signal to climb — [tutorial 6](Tutorial-06-Growing-Up).

## Drain

```text
{"ts":"…","level":"info","msg":"draining","signal":"SIGTERM","deadlineMs":15000,"inflight":0}
{"ts":"…","level":"info","msg":"stopped","signal":"SIGTERM"}
```

`/readyz` flips to 503 **before** the socket closes, which is what makes a rolling restart drain instead of drop. With zero in-flight work the whole drain completes in a millisecond and the socket is simply gone — do not expect to observe the 503 on an idle process.

Full role-by-role handoff table: [Deployment](Deployment).

## The other two build targets

```bash
bunx x build --target static --out .x/static
```

```text
✓ built static
```

One HTML file per `render: 'static'` route — with the default scaffold that is `.x/static/index.html`. Every other render mode needs a running app and is reported as skipped, never emitted. Serve it from a CDN or an object store with no process behind it; set `SITE_ORIGIN` so `canonical` and `og:url` are built against the real host.

```bash
bunx x build --target binary --out .x/app
```

```text
✓ built binary
```

It boots `As of 2026-08` — the 1.1.0 gap where it crashed at import on `/$bunfs/package.json` is closed. `x build` compiles the installed framework's version in as `--define ULTIMATE_FRAMEWORK_VERSION="<version>"`, because a single-file executable carries no `package.json` to read one from. Compile it any other way and it exits `X_INVARIANT` naming that flag, rather than reporting a version it does not have.

Use `--target docker` anyway. The image is the self-contained artifact; the binary is a launcher for an app tree, and must be started from the app root with the source beside it — and no scaffolded app has yet been served from a bare VM this way.

## When one instance is not enough

```bash
bunx x deploy --image myapp:dev --dry-run
```

```text
  migrate    docker compose -f …/docker/docker-compose.prod.yml run --rm migrate
  web        docker compose -f …/docker/docker-compose.prod.yml up -d web
  sync       docker compose -f …/docker/docker-compose.prod.yml up -d sync
  worker     docker compose -f …/docker/docker-compose.prod.yml up -d worker
  scheduler  docker compose -f …/docker/docker-compose.prod.yml up -d scheduler
✓ containers only: 1 image, roles migrate,web,sync,worker,scheduler
```

Migrate to completion, then the serving roles. `--dry-run` prints the plan and runs nothing.

**One replica each for `web` and `sync`, and the file says so** `As of 2026-08`. Both publish a host port, one host port has exactly one binder, so both are `replicas: 1`. Leave them there — this tutorial's rung is one box. `worker` publishes no port and scales freely, so `deploy: { replicas: 4 }` on it is the knob you actually have here.

Scaling the two serving roles is the next rung, and it is not an edit to this file: put a reverse proxy of your own on the compose network and drop their `ports:` lines, or move to the chart's per-role HPA → [6 · Growing up](Tutorial-06-Growing-Up).

## What is not there yet

| Expected | Reality `As of 2026-08` |
|---|---|
| `/metrics` on the **app** port | `X_ROUTE_NOT_FOUND`, and that is deliberate. Every role — `web` included — serves `/metrics` on `METRICS_PORT`, default **9090**, because the Helm ingress routes `/` with no path exclusion and metrics on 3000 would be public. Scrape `http://<host>:9090/metrics`, not `:3000/metrics` |
| `x logs tail` | planned — `X_NOT_IMPLEMENTED`, with `x dev` → the `/_x` timeline panel as its fix |
| `x status` | planned — `x doctor --json` is the shipped answer |
| OTLP export, on by default | the exporter **ships** — `otlpSpanExporter()` / `otlpMetricExporter()`, OTLP/HTTP JSON — but the default is still the no-op, so nothing leaves the process until you register one: `configureTelemetry({ exporter: otlpSpanExporter() })` with `OTEL_EXPORTER_OTLP_ENDPOINT` set to a collector's HTTP receiver (`:4318` — `:4317` is gRPC and is refused) |
| a Helm chart in your app | **`x new` writes one** `As of 2026-08-19` — `docker/helm`, 8 files — so `x deploy --method helm` works here. On 3.0.0 and below it writes none: copy [`docker/helm`](https://github.com/developerz-ai/ultimate/tree/main/docker/helm) from the framework repo, or stay on `--method compose` |

## Next

[Tutorial 6 — growing up](Tutorial-06-Growing-Up): managed Postgres, a shared cache, one service per role, then Compose and Kubernetes — with the app code unchanged at every rung.

Related: [Deployment](Deployment) · [Configuration](Configuration) · [CLI reference](CLI-Reference) · [Known gaps](Known-Gaps) · [Troubleshooting](Troubleshooting)
