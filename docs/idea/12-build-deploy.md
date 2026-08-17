# Build & deploy

Three targets, one command. A deploy target is anything that runs containers — nothing else is required. Operating what comes out of it is [`docs/ops/`](../ops/README.md); this doc is the build contract, and does not repeat the runbooks.

## `x build`

```
x build --target docker     # one image, all roles (default)
x build --target binary     # single Bun-compiled executable, no runtime install
x build --target static     # site/ output only: HTML, assets, sitemap, feeds
```

| Target | Output | Use | State `As of 2026-08` |
|---|---|---|---|
| `docker` | one OCI image, `ROLE` selects behavior | the normal path ([`11-topology.md`](./11-topology.md)) | works — entry `docker/Dockerfile`, `ENTRYPOINT ["bun", "apps/web/server.ts"]` |
| `binary` | `dist/myapp` — `bun build --compile`, all roles inside | VMs, systemd, air-gapped, a CLI-shaped product | compiles and **boots**; not yet served from a bare VM |
| `static` | `dist/static/` — one self-contained HTML file per `render: 'static'` route | CDN / object storage, deployed independently | works — entry `apps/web/prerender.ts`. Emits **no** sitemap, robots, feeds or asset files `As of 2026-08` |

**`--target binary` boots `As of 2026-08`.** The framework's version is resolved on first call, not at module scope, and from the build define when there is no manifest to read ([`packages/core/src/version.ts`](../../packages/core/src/version.ts)) — so `x build --target binary` passes `--define ULTIMATE_FRAMEWORK_VERSION="<version>"` and the executable answers with it. A broken publish still fails loudly rather than reporting `undefined`: a manifest that exists and declares no semver throws as before, and a build with neither source exits `X_INVARIANT` naming the flag. [`packages/core/e2e/version.e2e.test.ts`](../../packages/core/e2e/version.e2e.test.ts) compiles a real executable and runs it, both ways, on every push — the gap existed because nothing executed the artifact. The bare-VM row in [Targets](#targets) is still **unproven**: booting is not serving, and no scaffolded app has been compiled and run on a VM.

All targets share one build ID (content hash), from `x.manifest.json`. It reaches a served page as the `x-ultimate-build` **response header** on every mode, and as a `<meta>` inside a `spa` shell. It is **not** stamped into asset filenames — there are no hashed asset files, because there is no client bundle to name (below).

`x build` runs six of `x verify`'s steps before it produces anything: `typecheck`, `lint`, `boundaries`, `filesize`, `package-shape`, `errors` ([`packages/cli/src/cmd-build.ts`](../../packages/cli/src/cmd-build.ts)). It does **not** run `budgets`, `contract`, `drift` or any test suite — `x verify` is still the gate, and `x build` is the subset that can run before an artifact exists.

## What a build compiles

Two source kinds need a compiler before an Ultimate app runs at all, and both are Bun runtime loaders installed by `@ultimat3/render` ([`packages/render/src/module-loader.ts`](../../packages/render/src/module-loader.ts)) rather than a separate bundling pass. `x dev`, `x build` and `bun test` therefore load a page through exactly one code path.

| Source | Compiled to | Why a loader, not `tsconfig` |
|---|---|---|
| `*.tsx` | `h(…)` calls into render's server JSX factory ([`packages/render/src/jsx.ts`](../../packages/render/src/jsx.ts)) | `jsx: 'preserve'` makes Bun fall back to the **classic** `React.createElement` factory and ignore `jsxImportSource` entirely. `jsxImportSource: 'solid-js'` stays, because that is where the JSX *type* namespace lives — the runtime factory is the framework's |
| `*.module.scss` | CSS plus the scoped class map the `import styles from …` already assumes ([`packages/render/src/css-modules.ts`](../../packages/render/src/css-modules.ts)) | Bun has no SCSS loader; without one, `styles` is the *path string* and every `styles.foo` is `undefined` |

Class names are content-addressed (`hero_92a494d7`), so two checkouts at different paths compile to byte-identical CSS. A stylesheet that does not compile is `X_PRERENDER_FAILED` naming the file — never a silently unstyled page.

The compiled CSS is **inlined** into the document as one `<style>`, filtered to the route's own surface: a `site/` page never carries `app/` CSS ([axiom 6](./00-thesis.md)). Inline rather than linked because a `site/` artifact is a single file a CDN serves with no round trip and no second upload.

**There is no client bundle `As of 2026-08`.** Nothing calls `Bun.build` anywhere in the framework, so there are no chunks, no code splitting, no `modulepreload`, and nothing to hydrate with. The blocker is **ours, not upstream's**: `solid-js@1.9.14` ships `solid-js/web` with `render`, `hydrate`, `renderToString` and `generateHydrationScript`. What is missing is a compile step. Solid turns JSX into `template()` calls at build time — its `jsx-runtime` subpath carries *types* and no factory — so the client needs a Solid-compiled bundle graph of its own, separate from the inert `h` the server renders through. Islands, `hydrate: 'idle' | 'visible' | 'interaction'` and `renderSpaShell`'s `chunks` are declared and unbacked until that graph exists. Pages render server-side and ship 0 bytes of JS, which is correct for `site/` and incomplete for `app/`.

Async data does **not** wait on any of this: `renderToHtml` awaits async components and promise children, so a page loads its data by `await`ing it. Solid's `<Suspense>` is not the seam and throws outside a Solid renderer.

## Dev compose

```yaml
# docker/docker-compose.dev.yml — only needed for parity checks; `x dev` needs none of this
services:
  app:      { build: ., environment: { ROLE: all }, ports: ['3000:3000'] }
  postgres: { image: postgres:17, ports: ['5432:5432'] }
  nats:     { image: nats:2, command: '-js', ports: ['4222:4222'] }
  minio:    { image: minio/minio, command: 'server /data', ports: ['9000:9000'] }
```

`ROLE=all` runs every role in one process. The default local loop (`x dev`) uses embedded Postgres, in-process NATS, and a local directory for S3 — **Docker is not required to develop** ([`13-dx.md`](./13-dx.md)). This compose file exists for parity debugging and for CI jobs that want real services.

## Prod compose

Roles split, each scaled independently. Same image everywhere. `x new` writes an app-owned copy; [`docker/docker-compose.prod.yml`](../../docker/docker-compose.prod.yml) is the framework's.

```yaml
# docker/docker-compose.prod.yml
x-app: &app
  image: myapp:${BUILD_ID}
  env_file: .env.prod
  restart: unless-stopped

services:
  migrate:    { <<: *app, environment: { ROLE: migrate },    restart: 'no' }
  web:        { <<: *app, environment: { ROLE: web },        ports: ['3000:3000'],
                deploy: { replicas: 1 },
                depends_on: { migrate: { condition: service_completed_successfully } } }
  sync:       { <<: *app, environment: { ROLE: sync, PORT: 3000 }, ports: ['3001:3001'],
                deploy: { replicas: 1 } }
  worker:     { <<: *app, environment: { ROLE: worker, WORKER_QUEUES: 'default,integrations' },
                deploy: { replicas: 4 } }
  scheduler:  { <<: *app, environment: { ROLE: scheduler },  deploy: { replicas: 1 } }
  replicator: { <<: *app, environment: { ROLE: replicator }, deploy: { replicas: 1 } }
```

| Rule | Reason |
|---|---|
| `migrate` completes before `web`/`sync` start | a new schema must exist before new code reads it |
| `scheduler` and `replicator` at 1 replica | leader lock makes a second one a standby, not throughput |
| `stop_grace_period` >= `DRAIN_TIMEOUT` | otherwise SIGKILL truncates the drain and the reconnect fanout ([`11-topology.md`](./11-topology.md)) |
| Health probes from `/readyz` | never from a TCP check — a process can accept sockets while unable to serve |

| A role that publishes a host port at `replicas: 1` | one host port has exactly one binder — the second replica dies with `Bind for 0.0.0.0:3000 failed: port is already allocated` |
| `sync` at `PORT: 3000` while publishing `3001` | the role binds `PORT + 1`, so `PORT: 3001` opens 3002 and publishes a socket nothing listens on |

**Compose without a proxy in front is a one-replica rung**, and every file now declares that ceiling rather than violating it — the framework's, both tracked apps', and the one `x new` scaffolds, `As of 2026-08`. Scale a role here by putting a proxy on the network and deleting the `ports:` line, or by climbing to the chart's per-role HPA ([`17-scale-ladder.md`](./17-scale-ladder.md)). The framework ships neither proxy: it would be a second answer to "how does traffic reach a role", beside the chart's Ingress.

`x deploy --method compose --image <ref>` runs the plan against this file — migrate first, then the serving roles — and `--dry-run --json` prints it without running anything. It is a plain compose file you can read, diff, and run by hand.

## Helm chart

**A committed artifact, not a generated one.** [`docker/helm/`](../../docker/helm/) is checked in and
read directly — `x build` has three targets (`docker`, `binary`, `static`) and no `--helm` flag;
one existed and was removed in 1.2.0. `x deploy --method helm --image <ref>` runs `helm upgrade`
against it, overriding `image.repository` and `image.tag`.

One `Deployment` per role. Ranges below are [`docker/helm/values.yaml`](../../docker/helm/values.yaml)
verbatim, `As of 2026-08` — change them there, not here:

| Role | HPA metric | `minReplicas`–`maxReplicas` | Notes |
|---|---|---|---|
| `web` | `rps`, via the ingress metric adapter | 3–30 | behind Ingress + CDN; `terminationGracePeriodSeconds` >= drain |
| `sync` | `connections` — concurrent websockets per pod | 2–40 | no session affinity; connection count is the only honest signal |
| `worker` | `queue_depth` — jobs waiting, exported by the worker role | 1–50 | one Deployment per queue when isolation matters |
| `scheduler` | none — `replicas: 1` | 1 | `PodDisruptionBudget` maxUnavailable 1; the leader **lease** covers overlap ([`../architecture/08-jobs-internals.md`](../architecture/08-jobs-internals.md)) |
| `replicator` | none — `replicas: 1` | 1 | `StatefulSet`-shaped for stable identity; owns the slot |
| `migrate` | n/a | — | pre-install/pre-upgrade `Job` hook; blocks the release on failure |

CPU-based autoscaling is wrong for `sync` and `worker`: a node holding 80k idle sockets is near-zero CPU and near-capacity, and a worker blocked on a slow HTTP call is idle CPU with a growing backlog.

**The chart scales on three metrics, and the app emits all three `As of 2026-08`.** `@ultimat3/core` ships the instruments under the chart's exact names — `http_requests_total`, `connections`, `queue_depth` — plus a Prometheus-text renderer, and each has one call site: `pipeline.ts`'s `finally`, `SocketRegistry.add`/`remove`, `worker.ts`'s tick. Every role serves `METRICS_PATH` on `METRICS_PORT` (default 9090, never the app port), the chart declares that port on every role but `migrate` and publishes it on the Service, and [`docker/helm/templates/servicemonitor.yaml`](../../docker/helm/templates/servicemonitor.yaml) gives Prometheus a scrape target behind `serviceMonitor.enabled` ([`11-topology.md`](./11-topology.md#autoscaling-signals-honestly)). What the framework still does not supply is the last hop: a **custom-metrics adapter** in the cluster, which is the operator's and never the chart's. Without one an HPA pointed at these sits at `<unknown>` — disable it and pin `replicas` until the adapter is installed.

## Static deploys independently

```
x build --target static --out dist/static     # then upload dist/static to a CDN or bucket
```

`x deploy` has two methods, `compose` and `helm`; pushing static output is not one of them, and no `--to <cdn>` flag exists. Copying a directory is the vendor's own CLI, which is [axiom 7](./00-thesis.md) working as intended — the framework does not grow an uploader per host.

The build also writes `.x/build-stats.json` — one measured `jsBytes` per prerendered route, counted from the emitted document's own `<script>` tags — which is what the `budgets` step of `x verify` compares a declared `budget.js` against. A route that declares a budget and is not in that file is `X_BUDGET_UNMEASURED`, so only `render: 'static'` routes clear the gate today; every other mode needs a running process and is not weighed. `budget.css` is declared and unmeasured `As of 2026-08`.

The `site/` output is a separate artifact with a separate lifecycle.

| Property | Consequence |
|---|---|
| Static build does not include the app image | a copy change, a new blog post, a pricing tweak **does not redeploy the API** |
| Independent version, shared build ID namespace | assets stay resolvable across N deploys ([`08-pwa-offline.md`](./08-pwa-offline.md)) |
| ISR pages regenerate server-side and push to the CDN | no full rebuild for one changed record |
| Rollback is a pointer swap | seconds, no container churn |
| Cache purge | tag-driven, one hop from the write ([`05-caching.md`](./05-caching.md)) |

This is the deployment-level expression of [axiom 6](./00-thesis.md): the static path never pays for the app path — including at deploy time. Marketing shipping ten times a day must never risk the API.

## Targets

The framework's only requirement: **something that runs containers, plus Postgres.** NATS and object storage are optional in small deployments (Postgres covers queue and pubsub; a local volume covers files).

| Target | How | Notes |
|---|---|---|
| Render / Railway / Heroku, free or hobby tier | one web service, their managed Postgres, `ROLE=migrate` as the pre-deploy command | the entry point the whole ladder is arranged around — rung 0 in [`17-scale-ladder.md`](./17-scale-ladder.md) |
| Hetzner + Compose | `docker-compose.prod.yml` on one or two boxes | cheapest credible production; a $50 node runs all roles. One replica per role until a proxy fronts the host port |
| Fly.io | one app per role, or process groups | drain semantics map cleanly to Fly's SIGTERM handling |
| AWS ECS / Fargate | one task definition per role | ALB for `web`, NLB for `sync` |
| Any Kubernetes | the Helm chart under [`docker/helm`](../../docker/helm) | EKS, GKE, AKS, k3s — no cloud-specific resources. Not emitted by `x new`; copy it |
| Bare VM | `--target binary` + systemd units per role | no container runtime at all — **unproven**, not blocked. The binary boots and answers `--version` on every push (above), and `docker/Dockerfile` ends in `/out/app --version` so a binary that cannot answer fails the image build. Booting is not serving: no scaffolded app has been compiled, installed under systemd and served traffic from a VM |

None of the rows above is verified end to end by this repo. The two-platform deploy proof is [`14-roadmap.md`](./14-roadmap.md)'s one open milestone-11 item.

Not supported, by design: vendor edge runtimes, serverless-function-per-route, vendor KV/queue/cron primitives. Those would each need a second implementation of a framework primitive, and the second implementation is where behavior diverges ([axiom 7](./00-thesis.md)).

## Release checklist

```
x verify                       # the gate — green means shippable
x build --target docker
ROLE=migrate <image>           # pre-deploy, must exit 0
<roll web + sync>              # drain-aware; clients reconnect with backoff
x build --target static        # independently, whenever copy changes
x status --json                # build-ID distribution of connected clients — PLANNED
```

`x status` is a **planned** command `As of 2026-08`: it is in the registry and exits `X_NOT_IMPLEMENTED` naming the closest shipped command, rather than a typo error. The rest of the checklist runs today.

Rollback: redeploy the previous image tag. The previous build's assets are still served under the N-deploy retention window, so a rollback does not 404 anyone mid-session.
