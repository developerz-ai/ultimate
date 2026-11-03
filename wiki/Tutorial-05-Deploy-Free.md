# Tutorial 5 — deploy on a free tier

The framework ships **no** platform primitives — no buildpack, no `app.json`, no `fly.toml`, no adapter. It does not need to: every PaaS builds a Dockerfile, and every one of them wants the same three behaviours the scaffolded image already has.

`As of 2026-11-03`. Every command on this page down to [When one instance is not enough](#when-one-instance-is-not-enough) was re-run on a fresh `x new myapp --no-example` app carrying the tutorial 2–4 slices, with Docker 29 on Linux, its framework packed from this tree into `vendor/` the way `docker/deploy-proof/run.sh` packs it. `ROLE=migrate` ran against a real Postgres. **Not run: anything on a platform** — no host was used, so the platform table, the free-tier behaviour and the `x deploy` without `--dry-run` are still read, not measured. `scripts/tutorial-run.ts` does not run this page.

Series: [1 — first app](Tutorial-01-First-App) · [2 — first feature](Tutorial-02-First-Feature) · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · **5** · [6 — growing up](Tutorial-06-Growing-Up)

## The whole integration

| The platform does | The image does |
|---|---|
| injects `PORT`, routes traffic to it | `apps/web/server.ts` binds exactly `$PORT`, refusing a non-port value with `X_PORT_INVALID` rather than defaulting past it |
| requires a bind on `0.0.0.0` | binds every interface — loopback is unreachable through a port mapping |
| polls a health path | `/readyz` for *may I have traffic*, `/healthz` for *am I alive* |
| sends `SIGTERM`, then `SIGKILL` | drains in three phases: stop accepting, finish in-flight, close |
| wants one artifact per release | one image, `ROLE` selects the process |

Set `DATABASE_URL` and the three signing secrets below. Point the platform at `docker/Dockerfile`. That is the integration.

## Build

```bash
bunx x build --target docker --tag myapp:dev
```

```text
✓ built docker
```

```text
myapp:dev  300MB
```

`300MB` is a 29.4.0 scaffold's image, measured 2026-11-03 (the 1.1.0 image was 194MB).

`x build` runs the static gate steps first — `typecheck`, `lint`, `boundaries`, `filesize`, `package-shape`, `errors` — and exits non-zero without building if any fail. A build that would fail `x verify` produces no artifact.

The scaffolded image is `oven/bun:1.4-alpine`, pinned by digest, in three stages (`manifests`, `deps` with `bun install --frozen-lockfile --production`, `runtime`). It runs as `USER 1000:1000`, and its `ENTRYPOINT` is `["bun", "apps/web/server.ts"]`. There is no compile stage and no second gate inside it: re-running `tsc` and `biome` there would need the devDependencies the `--production` install deliberately omits.

> `docs/ops/README.md` also describes a distroless, single-binary image. That is **this repo's own** CLI image (`docker/Dockerfile` in the framework repository), not what `x new` writes — your app's `docker/Dockerfile` is the authority for your image.

## Run it, locally, exactly as the platform will

```bash
docker run -d --name myapp-web -e ROLE=web -e PORT=8080 -p 8085:8080 \
  -e SESSION_SECRET=$(openssl rand -hex 32) -e ULTIMATE_CURSOR_SECRET=$(openssl rand -hex 32) \
  -e STORAGE_SIGNING_SECRET=$(openssl rand -hex 32) myapp:dev
```

```text
{"ts":"2026-11-03T16:23:42.394Z","level":"info","msg":"ultimate metrics listening","url":"http://0.0.0.0:9090/metrics"}
{"ts":"2026-11-03T16:23:46.918Z","level":"info","msg":"app mcp mounted","method":"POST","path":"/mcp"}
{"ts":"2026-11-03T16:23:46.961Z","level":"info","msg":"ultimate web listening on http://0.0.0.0:8080"}
{"ts":"2026-11-03T16:23:46.962Z","level":"info","msg":"ultimate started","role":"web","url":"http://0.0.0.0:8080","buildId":"edca46484ed2b43f","bus":"in-process"}
```

Without the secrets it exits at boot, one refusal at a time: `X_CURSOR_SECRET_DEV` names `ULTIMATE_CURSOR_SECRET`, then `X_ENV_MISSING` names `STORAGE_SIGNING_SECRET` (an image with no `S3_ENDPOINT` stores uploads on its own disk). `ULTIMATE_ENV=production bunx x env check` lists them all before you build.

```bash
curl http://127.0.0.1:8085/readyz
```

```json
{"state":"ready","ready":true,"role":"web"}
```

The verdict, and nothing else: a published port reaches the container from the bridge gateway,
not from loopback, and only a peer `healthDetailPeers` lists is told the build id, the in-flight
count and the check names. From inside the container it is loopback, and they are printed:

```bash
docker exec myapp-web bun --eval "fetch('http://127.0.0.1:8080/readyz').then(r=>r.text()).then(console.log)"
```

```json
{"state":"ready","ready":true,"uptimeMs":5236,"inflight":0,"buildId":"edca46484ed2b43f","checks":{"database":"ok"},"registered":1,"role":"web"}
```

The image's own `HEALTHCHECK` (`/readyz` every 10s, a 30s start period) reported `healthy` 5s after the start. Prove that locally before you debug it on a platform.

### The env vars that matter

| Key | Unset means | Set it to |
|---|---|---|
| `ROLE` | `web` | `web` for the service, `migrate` for the release phase |
| `PORT` | 3000 | whatever the platform injects — leave it to the platform |
| `DATABASE_URL` | **embedded PGlite** — never in production | the managed Postgres connection string |
| `SESSION_SECRET`, `ULTIMATE_CURSOR_SECRET`, `STORAGE_SIGNING_SECRET` | the shipped development keys, which a production boot refuses | `openssl rand -hex 32` each, in the platform's secret store |

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
{"ts":"2026-11-03T16:24:07.231Z","level":"info","msg":"ultimate migrate applied","applied":2,"available":2,"appVersion":"dev"}
```

It applies every pending migration in `packages/db/migrations` under a Postgres advisory lock, records each in the `x_migrations` ledger with its checksum, and exits 0. Concurrent migrators serialise — the second waits up to 60s for the lock, then exits non-zero with `X_MIGRATE_CONCURRENT` rather than hanging the release; a checksum that no longer matches an applied migration stops the release rather than corrupting it.

Every setting each host asks for, and which were executed: [Deploy recipes](Deploy-Recipes).

| Platform | Where the command goes |
|---|---|
| Heroku | `release:` in `Procfile`, with `ROLE=migrate` on the release dyno |
| Render | a pre-deploy command running `ROLE=migrate bun apps/web/server.ts` |
| Fly.io | `[deploy] release_command` with `ROLE=migrate` |
| Railway | a pre-deploy command running the same |
| Kubernetes | an `initContainer` or a `Job` on the same image |
| Compose | the `migrate` service; every other role waits on `service_completed_successfully` |

**No release phase on your free tier?** Several platforms gate pre-deploy commands behind a paid plan. Run the one-off yourself against the same image and the same `DATABASE_URL` before promoting the release — that is what every row above ultimately is.

`x db migrate` is deliberately absent from that table: it is the developer's command, and it needs the toolchain ([tutorial 2](Tutorial-02-First-Feature#migrations)). The release phase runs the shipped image and nothing else.

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

`docker stop -t 20 myapp-web`:

```text
{"ts":"2026-11-03T16:23:52.649Z","level":"info","msg":"draining","signal":"SIGTERM","deadlineMs":25000,"readinessGraceMs":5000,"inflight":0}
{"ts":"2026-11-03T16:23:57.656Z","level":"info","msg":"stopped","signal":"SIGTERM"}
```

`/readyz` flips to 503 **before** the socket closes, and stays 503 for `readinessGraceMs` (5s) with the listener still open, so a load balancer polling it stops sending traffic before the socket goes — that is what makes a rolling restart drain instead of drop. An idle process stops at the end of the grace: 5s here.

Full role-by-role handoff table: [Deployment](Deployment).

## The other two build targets

```bash
bunx x build --target static --out .x/static
```

```text
  skipped  /todos      app/ surface — server-rendered, not prerendered; app/ allows stream | ssr, so no route on it can ever reach the artifact
✓ built static
```

One HTML file per `render: 'static'` route — with this scaffold, `.x/static/index.html` beside `404.html`, the `offline` page, the manifest, icons, islands and styles. Every other render mode needs a running app and is listed as `skipped` (one line per route), never emitted. Serve it from a CDN or an object store with no process behind it; set `SITE_ORIGIN` so `canonical` and `og:url` are built against the real host.

`apps/web/prerender.ts` also writes **`sitemap.xml` and `robots.txt`** into the same directory, because a static export has no process to answer them at request time. `robots.txt` **fails closed**: anything that is not `ULTIMATE_ENV=production` emits `Disallow: /` and advertises no sitemap, so a preview build cannot outrank the real site.

```bash
bunx x build --target binary --out .x/app
```

```text
✓ built binary
```

It boots `As of 2026-10-06`: the required `windows` CI job starts a scaffold's binary and gets `200` from `/healthz`, and a Linux e2e test runs a compiled probe tree. The framework is **not** compiled in: `x build` keeps `@ultimat3/*` external, so `@ultimat3/core` loads from the app's `node_modules` and `frameworkVersion()` reads its version from core's own `package.json` there (`resolveVersion`, `packages/core/src/version.ts`). `x build` still passes `--define ULTIMATE_FRAMEWORK_VERSION="<version>"`, but nothing in this binary reads it — the define answers only for a build that bundles the framework, such as the image's self-contained `x`. Such a build compiled without the define, and with no `package.json` beside core, exits `X_INVARIANT` (fix `x build --target binary`) rather than reporting a version it does not have.

Use `--target docker` anyway. The image is the self-contained artifact; the binary is a launcher for an app tree, and must be started from the app root with the source beside it — and no scaffolded app has yet been served from a bare VM this way.

## When one instance is not enough

```bash
bunx x deploy --image myapp:dev --dry-run
```

```text
  migrate    IMAGE=myapp:dev docker compose --env-file …/.env.production -f …/docker/docker-compose.prod.yml run --rm migrate
  web        IMAGE=myapp:dev docker compose --env-file …/.env.production -f …/docker/docker-compose.prod.yml up -d web
  sync       IMAGE=myapp:dev docker compose --env-file …/.env.production -f …/docker/docker-compose.prod.yml up -d sync
  worker     IMAGE=myapp:dev docker compose --env-file …/.env.production -f …/docker/docker-compose.prod.yml up -d --no-deps --no-recreate --wait --wait-timeout 300 --scale worker=2 worker
  scheduler  IMAGE=myapp:dev docker compose --env-file …/.env.production -f …/docker/docker-compose.prod.yml up -d --no-deps --no-recreate --wait --wait-timeout 300 --scale scheduler=2 scheduler
  backfill   IMAGE=myapp:dev docker compose --env-file …/.env.production -f …/docker/docker-compose.prod.yml run --rm backfill
✓ containers only: 1 image, roles migrate,web,sync,worker,scheduler,backfill
```

Migrate to completion, then the serving roles, then the one-shot `backfill`. `--dry-run` prints the plan and runs nothing. `…` is the app root, printed absolute.

**`--env-file` is what fills the `${VAR:?…}` guards.** Compose interpolates `SYNC_URL`, `APP_URL` and `POSTGRES_PASSWORD` from the shell and `--env-file` only, never from a service's `env_file:`. So all three go in `.env.production` — `APP_URL=http://<host>:3000` is the origin your pages are served on, and the only one besides its own that `sync` admits a socket from, and every step reads that file. A variable set in the shell still wins over it.

**At most one replica each for `web` and `sync`, and the file says so** `As of 2026-11-03`. Both publish a host port, and one host port has exactly one binder: `web` is `replicas: 1`, and `sync` is `replicas: 0` — off — until the app turns realtime on with a replicator and NATS (the comment above it in `docker/docker-compose.prod.yml` is the recipe), then `1`. Leave them there — this tutorial's rung is one box. `worker` publishes no port and scales freely, so `deploy: { replicas: 4 }` on it is the knob you actually have here; the plan rolls `worker` and `scheduler` by starting a second copy beside the first (`--scale <role>=2 --wait`).

Scaling the two serving roles is the next rung, and it is not an edit to this file: put a reverse proxy of your own on the compose network and drop their `ports:` lines, or move to the chart's per-role HPA → [6 · Growing up](Tutorial-06-Growing-Up).

## What is not there yet

| Expected | Reality `As of 2026-08` |
|---|---|
| `/metrics` on the **app** port | `X_ROUTE_NOT_FOUND`, and that is deliberate. Every role — `web` included — serves `/metrics` on `METRICS_PORT`, default **9090**, because the Helm ingress routes `/` with no path exclusion and metrics on 3000 would be public. Scrape `http://<host>:9090/metrics`, not `:3000/metrics` |
| `x logs tail` | planned — `X_NOT_IMPLEMENTED`, with `x dev` → the `/_x` timeline panel as its fix |
| `x status` | planned — `x doctor --json` is the shipped answer |
| OTLP export, on by default | the exporter **ships** — `otlpSpanExporter()` / `otlpMetricExporter()`, OTLP/HTTP JSON — but the default is still the no-op, so nothing leaves the process until you register one: `configureTelemetry({ exporter: otlpSpanExporter() })` with `OTEL_EXPORTER_OTLP_ENDPOINT` set to a collector's HTTP receiver (`:4318` — `:4317` is gRPC and is refused) |
| a Helm chart in your app | **`x new` writes one** `As of 2026-11-03` — `docker/helm`, 10 files — so `x deploy --method helm` works here. On 3.0.0 and below it writes none: copy [`docker/helm`](https://github.com/developerz-ai/ultimate/tree/main/docker/helm) from the framework repo, or stay on `--method compose` |

## Next

[Tutorial 6 — growing up](Tutorial-06-Growing-Up): managed Postgres, a shared cache, one service per role, then Compose and Kubernetes — with the app code unchanged at every rung.

Related: [Deployment](Deployment) · [Configuration](Configuration) · [CLI reference](CLI-Reference) · [Known gaps](Known-Gaps) · [Troubleshooting](Troubleshooting)
