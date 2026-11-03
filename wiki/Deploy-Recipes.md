# Deploy recipes

One section per host. The framework ships no host config file, no generator and no adapter: every
host below builds the same `docker/Dockerfile` and runs the same image once per role. A recipe is
the handful of settings that host asks for, and nothing more. A host joins this page by a PR that
ran it, and each section says whether it was **executed** or **not executed**, with its date.

What every host needs, whatever its words for it:

| Setting | Value |
|---|---|
| build source | `docker/Dockerfile`, context the app root |
| port | the host injects `PORT`; `web` binds exactly it, every interface |
| health path | `/readyz` (may it take traffic) — never a TCP check |
| release command | the image's own entry with `ROLE=migrate`: `env ROLE=migrate bun apps/web/server.ts`, exit 0 before any role serves |
| services | one per role from the one image, `ROLE` set on each: `web`, `worker`, `scheduler`; `sync` only once realtime is on ([Deployment](Deployment#routing-a-proxy-to-the-sync-role)) |
| environment | `ULTIMATE_ENV=production`, `DATABASE_URL`, `ULTIMATE_CURSOR_SECRET`, `STORAGE_SIGNING_SECRET` (unless `S3_ENDPOINT` and `S3_BUCKET` are set), `SESSION_SECRET`, `APP_URL` — `x env init --production` writes them all with fresh secrets; copy the values into the host's secret store. `NODE_ENV=production x env check --json` asks what a deployed boot would refuse |

## One box, Compose

`As of 2026-11-03` — **executed**, and on every push: the `compose-deploy` CI job runs
[`docker/deploy-proof/compose.sh`](https://github.com/developerz-ai/ultimate/blob/main/docker/deploy-proof/compose.sh)
on a fresh scaffold.

```sh
x env init --production         # .env.production: secrets generated, gitignored, mode 600
x build --target docker         # ultimate-app:dev
x deploy                        # migrate, then web, worker, scheduler; backfill last
curl -fsS http://127.0.0.1:3000/readyz
```

| Setting | Here |
|---|---|
| build source | `x build --target docker`; `--image` names any other tag |
| port | `3000:3000` published by `web`, `3001:3001` by `sync` |
| health path | each service's healthcheck: `/readyz` for `web`/`sync`, `/metrics` for the rest |
| release command | the `migrate` service, `run --rm`; every role waits on `service_completed_successfully` |
| services | `docker/docker-compose.prod.yml`, one per role |
| what it loses | nothing to a free tier — it is your box. `web` and `sync` stay at one replica each: one host port, one binder |

`APP_URL` and `SYNC_URL` are written for `localhost`: set the host your users reach before they do.

## Kubernetes, the chart

`As of 2026-11-03` — **executed**: the `deploy-proof` CI job installs a scaffold into kind with
`x deploy --method helm` and upgrades it under load with zero failed requests.

| Setting | Here |
|---|---|
| build source | your registry; `x deploy --method helm --image <repo>:<tag>` |
| port | the chart's per-role Service; `ingress.host` sets `APP_URL` on `sync` |
| health path | `startupProbe`, `readinessProbe` on `/readyz`, liveness on `/healthz` |
| release command | the chart's `migrate` Job, a pre-install/pre-upgrade hook |
| services | one Deployment per role, an HPA each |
| what it loses | nothing to a free tier; the cluster is the cost |

## Fly.io

`As of 2026-11-03` — **not executed**.

| Setting | Here |
|---|---|
| build source | `fly launch --no-deploy --dockerfile docker/Dockerfile`; the `fly.toml` it writes is yours |
| port | `[http_service] internal_port = 8080` and `[env] PORT = "8080"` |
| health path | `[[http_service.checks]] path = "/readyz"` |
| release command | `[deploy] release_command = "env ROLE=migrate bun apps/web/server.ts"` |
| services | `[processes]` is a command per group, and the image's `ENTRYPOINT` reads `ROLE`: one Fly app per role (`fly apps create <app>-worker`), each with `ROLE` in `[env]` |
| what it loses | machines that stop when idle stop `worker` and `scheduler` with them ([Tutorial 5](Tutorial-05-Deploy-Free#what-a-free-tier-costs-you)) |

## Render

`As of 2026-11-03` — **not executed**.

| Setting | Here |
|---|---|
| build source | a Docker web service, Dockerfile path `docker/Dockerfile`, context `.` |
| port | Render injects `PORT` |
| health path | Health Check Path `/readyz` |
| release command | Pre-Deploy Command `env ROLE=migrate bun apps/web/server.ts` — a paid instance type only |
| services | a web service with `ROLE=web`; a background worker per other role, same repository and Dockerfile |
| what it loses | a free web service sleeps when idle, and free has no background worker and no pre-deploy command: run the migrate one-off yourself before promoting |

## Railway

`As of 2026-11-03` — **not executed**.

| Setting | Here |
|---|---|
| build source | `RAILWAY_DOCKERFILE_PATH=docker/Dockerfile` on each service |
| port | Railway injects `PORT` |
| health path | Healthcheck Path `/readyz` |
| release command | Pre-Deploy Command `env ROLE=migrate bun apps/web/server.ts` on the `web` service |
| services | one service per role from the same repository, `ROLE` set on each |
| what it loses | the trial's credit, then usage billing; a service with serverless sleep on stops `worker` and `scheduler` with it |

## Heroku

`As of 2026-11-03` — **not executed**. Heroku has had no free dynos since 2022-11-28.

| Setting | Here |
|---|---|
| build source | `heroku stack:set container`, then a `heroku.yml` with `build: { docker: { web: docker/Dockerfile } }` |
| port | Heroku injects `PORT` |
| health path | none on the router; the drain still answers `/readyz` for a check you run |
| release command | `release: { image: web, command: ['env', 'ROLE=migrate', 'bun', 'apps/web/server.ts'] }` in `heroku.yml` |
| services | one process type per role in `run:`, each `env ROLE=<role> bun apps/web/server.ts` |
| what it loses | no free tier at all |

## Bare VM, no container runtime

`As of 2026-11-03` — **not executed** as a deploy. The `windows` CI job boots a scaffold's binary
and gets `200` from `/healthz`; no scaffold has been served from a VM this way
([Tutorial 5](Tutorial-05-Deploy-Free#the-other-two-build-targets), [Bare VM](Bare-VM)).

| Setting | Here |
|---|---|
| build source | `x build --target binary --out .x/app`, started from the app root with the source beside it |
| port | `PORT` in each unit's environment |
| health path | `/readyz`, from your proxy or monitor |
| release command | `ROLE=migrate .x/app` once, before the units restart |
| services | one systemd unit per role, `Environment=ROLE=<role>` |
| what it loses | the image's reproducibility: the box's Bun and `node_modules` are the runtime |
