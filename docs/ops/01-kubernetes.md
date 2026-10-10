# Deploying on Kubernetes

One namespace per app. One image, six roles, one Deployment per role. No per-app database, no
per-app cache, no per-app mail relay — an app slots into shared cluster services or it does not
belong on a shared cluster.

Nothing here is required by the framework. Ultimate emits a container; this is the shape that a
multi-app cluster converges on, from an operator running exactly this stack in production
(`As of 2026-08`).

## Two ways in, and when each is right

| | [`docker/helm/`](../../docker/helm/) (shipped) | flat kustomize manifests |
|---|---|---|
| Best when | the cluster is yours alone, or the app is the only tenant | the cluster is shared, GitOps-managed, and reviewed by people who did not write the chart |
| Deploy | `helm upgrade --install` | `git push`, a GitOps controller applies |
| Cost | the values file is the whole API; the diff a reviewer sees is a values diff | more files, but every file is a real Kubernetes object a reviewer can read |
| Migrations | `pre-install,pre-upgrade` hook Job — correct ordering out of the box | you own the ordering; see below |

Pick one per app and never carry both. A repo with a chart *and* a manifest tree has two sources of
truth for the same pod.

## The manifest set

Flat `manifests/`. No `base/` + `overlays/` — a two-directory kustomize tree buys you nothing when
there is one environment, and it hides the object a reviewer needs to see.

| File | Holds |
|---|---|
| `namespace.yml` | the app's namespace, nothing else |
| `configmap.yml` | non-secret env: `NODE_ENV`, `LOG_LEVEL`, `TZ`, `PORT` |
| `sealed-secret.yml` | encrypted env — [`02-secrets.md`](./02-secrets.md) |
| `pull-secret.yml` | registry credential, if the image is private |
| `deployment-<role>.yml` | one per serving role: `web`, `sync`, `worker`, `scheduler` |
| `service.yml` | `ClusterIP` per role that listens (`web`, `sync`) |
| `certificate.yml` | TLS cert request for the public hostname |
| `ingressroute.yml` (or `ingress.yml`) | the public route |
| `servicemonitor.yml` | scrape config — [`03-observability.md`](./03-observability.md) |
| `kustomization.yml` | the resource list and the image override |

## Role → workload

| Role | Kubernetes shape | Replicas | Probes |
|---|---|---|---|
| `web` | Deployment + Service + Ingress | HPA on request rate | `/readyz` readiness, `/healthz` liveness on `:3000` |
| `sync` | Deployment + Service, routed at `/_x/sync` | HPA on connections per pod | same, on `:3001` |
| `worker` | Deployment + a **headless** Service (no ClusterIP — it exists so a ServiceMonitor can select the `metrics` port) | HPA on queue depth, an `External` metric | liveness on `/metrics`, readiness on `/readyz`, both `:9090` |
| `scheduler` | Deployment, `replicas: 1` | fixed — the leader is an expiring row in `x_scheduler_leader`, not an advisory lock | liveness on `/metrics`, readiness on `/readyz`, both `:9090` |
| `migrate` | Job, run-once before any serving role | 1 | none |
| `replicator` | Deployment, `replicas: 1` **per database** | fixed — holds a replication slot under a session advisory lock | liveness on `/metrics`, readiness on `/readyz?deep=1`, both `:9090` |

**Probes follow the role, because the roles do not agree on what they open.** `web` and `sync`
construct a server and get `/readyz` + `/healthz` on it. `worker`, `scheduler` and `replicator`
construct none — their only socket is the metrics listener
([`packages/cli/src/metrics-endpoint.ts`](../../packages/cli/src/metrics-endpoint.ts)), which answers
`METRICS_PATH`, `/healthz` and `/readyz` (the verdict only, never the check names) — so they get a
liveness probe on `/metrics` and a readiness probe on `/readyz` of the same port (`As of
2026-10-05`): 503 until the role has started, and again from the first instant of a drain. Without
it a worker pod was Ready the moment its scrape port bound, so a rollout could replace every old
worker with new ones that crashed later in boot. The replicator reads `/readyz?deep=1` — deep, so an app's `readiness: 'process'` cannot report a stopped stream as ready. Probing `/healthz` on a port they never bound is the bug that made sync's readiness
probe meaningless; leaving them with no probe is how a wedged worker was never restarted.

**`WORKER_QUEUES` is the exact set a worker claims** (`As of 25.0.0`). Unset — the chart's one
worker Deployment — it serves `jobs.queues` plus every registered job's queue. Set, it serves those
comma-separated queues and no other: jobs on an unlisted queue wait for a worker that lists it, and
the boot warns `jobs.worker.queue-unserved` naming them (`packages/cli/src/runtime-jobs.ts`). The
chart's `env:` is release-wide, so each further worker Deployment is a release of its own with every
other role and `migrate` off (`roles.<role>.enabled`, `migrate.enabled`); `x jobs list --json` shows a
queue nobody claims.

**The replicator restarts its own stream, and says when it is not replicating** (`As of 2026-10-02`).
A stream that ends — a failover, `wal_sender_timeout`, a rejected publish — or an advisory-lock
session that dies clears `replicator.running`, releases the lock and redials on a jittered backoff;
no pod restart is needed. The role registers a `replicator` readiness check over `running`, and a
dedicated `replicator` container answers it on the metrics port's `/readyz`: the chart's readiness
probe shows the pod 0/1 while no stream is up. Its headless Service publishes not-ready addresses,
so the pod is still scraped then. Alert on the `replicator.stream_ended` and
`replicator.restart_failed` log events as well — readiness says it is down, the log says why.

A non-leader `scheduler` stands by: it holds no lease, dispatches nothing, and reports the same
liveness and readiness as the leader — neither signal distinguishes them. A second replica is
harmless and idle, and also wasted money, so leave both at 1.

**`PORT` is the web port, and `sync` binds `PORT + 1`.** A sync pod given `PORT=3001` opens 3002,
so its `containerPort`, its Service `targetPort` and both probes point at a socket nobody bound and
the rollout never completes. Give the sync workload `PORT=3000` and a `containerPort` of 3001. The
chart derives this (`_helpers.tpl`); a hand-written manifest set does not, so put it in the
role's own env and never in the shared `configmap.yml` — one `PORT` for both roles is the bug.

**The start command is the app image's own.** An app image — the one `x new` writes and
`x build --target docker` builds — is `ENTRYPOINT ["bun", "apps/web/server.ts"]` with no `CMD`, and
that file calls `runRole` from `@ultimat3/cli/serve`, which reads `ROLE`. Neither the chart nor
[`docker-compose.prod.yml`](../../docker/docker-compose.prod.yml) sets a `command`, and neither
needs one. (`docker/Dockerfile` in this repository is the framework's **CLI** image — `/app/x` and
nothing else — and serves no role.)

**`sync` ships OFF, in both charts and both Compose files**, `As of 2026-09-23`. A `sync` pod on a
real database hears committed changes only from a replicator it can reach — in its own process, or
over NATS — and a fresh deploy has neither, so booted anyway it is refused with
`X_REALTIME_TOPOLOGY` (it used to start, report healthy, and deliver nothing to any live query or
channel). An app whose only realtime is **events-only channels** (no `live: true` query, no channel
with `records`) needs steps 1 and 4 and no replicator: its events are published by the app
(`publishChannelEvent`) through NATS, never read off the log, and such a node boots with `live=none`.
To turn realtime on:

| # | Step |
|---|---|
| 1 | Declare the bus in `app.config.ts` — `realtime: { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' }` — then run NATS (JetStream on) and set the **same** `NATS_URL` for `web`, `sync` and the replicator. Both halves or neither: since 22.0.0 `'nats'` with the variable unset, and a `NATS_URL` under `'memory'`, each refuse the boot with `X_CONFIG_INVALID`; `enabled: false` starts no `sync` node and no replicator |
| 2 | Start Postgres with `wal_level=logical`. The replicator's role needs `REPLICATION` — read [the grant is cluster-wide](#replication-is-a-cluster-wide-grant) first. The publication is the replicator's own: at boot it creates `x_changes` (`REPLICATION_PUBLICATION` overrides) `FOR TABLE` every registered entity table, and adds any entity table an existing one lacks — never removing one. `FOR TABLE`, because a table's owner may publish it without a superuser, so the role that ran the migrations can. A role that owns none of them is refused with `X_REPLICATION_FAILED` and the statement to run as one that does. TLS on the replicator's connection follows libpq's `sslmode`: `?sslmode=require` encrypts against a private-CA server (CNPG) without verifying it; `?sslmode=verify-full&sslrootcert=/path/ca.crt` verifies against the CA you mount — a failure is `X_REPLICATION_TLS`, naming the check |
| 3 | Enable exactly one replicator per database: `roles.replicator.enabled: true` (chart) or a `ROLE=replicator` service (Compose) |
| 4 | Enable sync: `roles.sync.enabled: true`, or `replicas: 1` on the Compose `sync` service. The chart's Ingress routes `/_x/sync` only while sync is enabled. The node refuses a socket from a page on another ORIGIN — scheme, host and port, compared exactly (`X_SOCKET_ORIGIN_REFUSED`); a socket is refused when its origin is not `APP_URL`'s when one is declared; with none declared, not the origin the node was reached on. With the Ingress enabled the chart sets `APP_URL` on the sync role from `ingress.host` (`https` when `ingress.tls`), and a declared origin is the whole list. `env.APP_URL` wins when set: state the page's origin there when the pages are served on another host than `ingress.host` |

### Replication is a cluster-wide grant

`REPLICATION` is a role attribute of the whole Postgres **cluster**, not of one database. A
`replication=database` session — the one the replicator opens — can also issue `BASE_BACKUP` and
`START_REPLICATION PHYSICAL`, and the walsender checks no database for either. So a role holding it
can:

| With `REPLICATION`, anyone holding the app's URL can | Because |
|---|---|
| copy every database on the cluster | a base backup is the whole data directory, `pg_authid` (every role's password hash) included |
| drop another application's replication slots | every physical slot, and the logical slots of any database it may connect to — `pg_drop_replication_slot` checks the attribute, not who created the slot |
| exhaust `max_wal_senders` | every other replica and CDC consumer on the cluster then fails to connect |

- **A cluster dedicated to the app** is the answer: the exposure is then the app's own data, which
  its URL already reached.
- **On a shared cluster, never grant `REPLICATION` to the app role.** If the replicator must run
  there, give it a role of its own through `REPLICATION_URL` (same host and database as
  `DATABASE_URL`, a different user) and restrict `pg_hba.conf`'s `replication` lines to that user
  and the replicator's source address, so the app's URL cannot open a walsender at all. That role
  owns no table, so its first boot is refused with the `CREATE PUBLICATION` to run once as the
  table owner.
- The replicator's refusals say this too: a missing `REPLICATION` attribute is `X_REPLICATION_FAILED`
  with a fix line pointing here, never a bare `ALTER ROLE … WITH REPLICATION`.

## Migrations

Run them as a **pre-deploy Job**, gated before any serving role starts. The shipped chart already
does this (`helm.sh/hook: pre-install,pre-upgrade`, `hook-weight: -5`), and
[`docker-compose.prod.yml`](../../docker/docker-compose.prod.yml) gates every role on
`migrate: { condition: service_completed_successfully }`.

**Since 24.0.0 the order is enforced, not advised.** Only `ROLE=migrate` (and `x db migrate`)
applies the framework's own tables — `x_jobs`, `x_outbox`, `x_users` and the rest — in one
transaction behind the migration advisory lock, with `lock_timeout` bounded at the migrate pool's
3 s, and stamps the build on `x_jobs`' table comment. A `web`, `sync`, `worker`, `scheduler` or
`replicator` pod on an external `DATABASE_URL` runs **no DDL**: it reads the stamp and refuses to
boot with `X_FRAMEWORK_SCHEMA_UNAPPLIED` (`fix: x db migrate`) when its build is not there. Every
pod used to run the DDL itself, so a pod start queued an `ACCESS EXCLUSIVE` `alter table` behind any
open transaction and every enqueue in the fleet queued behind that. An old pod restarting mid-roll
still boots — its build is further down the stamp — and one whose MAJOR differs from the newest
applied build logs `ultimate framework major skew` and serves. A migrate that meets an open
transaction fails in seconds with `X_FRAMEWORK_SCHEMA_FAILED` wrapping `X_DB_LOCK_TIMEOUT`; the
Job's `backoffLimit` retries it.

Two failure modes worth inheriting rather than rediscovering:

| Trap | What happens | Fix |
|---|---|---|
| A GitOps **PreSync** hook that migrates, when the same sync also creates the database | The hook waits for a database the sync has not created yet. Deadlock, forever. | Migrate in an init container inside the pod, or create the database in an earlier sync wave |
| Waiting on `pg_isready` before migrating | A shared Postgres accepts connections *before* it has finished creating this app's database and role. The migrate then fails `SQLSTATE 3D000`, `database "<app>" does not exist` | Wait on a real `SELECT 1` **against the target database**, not on the server being up |

### Expand then contract — non-negotiable

The chart rolls with `maxUnavailable: 0, maxSurge: 1`. Old and new pods therefore serve against
**one shared schema** for the length of the roll, and the migrate Job has already run.

| Release | May do | May not do |
|---|---|---|
| N | add a nullable column, add a table, add an index | drop, rename, or add `NOT NULL` to an existing column |
| N+1 | the drop or rename, once no pod runs release N-1's code | — |

Nothing enforces this at sync time. It is a review blocker: a migration that drops or renames in the
same release as the code that stops using it will break the still-running old pod mid-roll.

**RWO caveat:** `maxSurge: 1` briefly runs two pods, and a `ReadWriteOnce` volume cannot attach to
both. An Ultimate role holds no durable state, so this should never bite — if you have added a
volume, you have added state to a stateless role, and `strategy: Recreate` is the only honest answer.

## GitOps

The repo is the deploy. No `kubectl apply` to production by hand — a controller with `selfHeal: true`
reverts it within minutes and you will spend the outage arguing with a reconciler.

```yaml
# apps/<app>/application.yml — the pointer; the manifests live one directory down.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: <app>
  namespace: argocd
  finalizers: [resources-finalizer.argocd.argoproj.io]
spec:
  project: default
  source:
    repoURL: https://github.com/<org>/<deploy-repo>.git
    targetRevision: main
    path: apps/<app>/manifests
  destination:
    server: https://kubernetes.default.svc
    namespace: <app>
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```

### Image promotion, and the trap under it

CI builds and pushes; it holds **no cluster credential**. The handoff is image-only. A controller in
the cluster watches the registry, resolves the moving tag to an immutable digest, and patches the
live `Application`'s image list. Nothing is written back to git, so the deploy path needs no write
credential and never collides with branch protection.

That leaves one sharp edge, and it has cost real hours:

| Symptom | Cause | Fix |
|---|---|---|
| The digest patch is reverted every few minutes | A parent app-of-apps with `selfHeal: true` owns the child `Application` and reverts the patched field | `ignoreDifferences` on the patched path in the **parent** |
| Still reverted, even with `ignoreDifferences` | Plain `ignoreDifferences` is **display-only** | add `syncOptions: [RespectIgnoreDifferences=true]` — without it `selfHeal` still reverts |
| Permanently `OutOfSync` on a clean cluster | The patch *creates* the kustomize object on sources that have none in git, so ignoring only `.../images` leaves the parent object itself diffing | ignore the whole `/spec/source/kustomize` object, not just its `images` key |
| A pod-template annotation flips back and forth | A config-reload controller stamps a `last-reloaded-from` annotation to trigger the rollout; `selfHeal` strips it | `ignoreDifferences` on that one JSON pointer |

Rolling back is not a git revert, because the deploy never touched git. See
[`06-runbooks.md`](./06-runbooks.md) — and pause the image watcher **first**, or it re-applies the
bad digest on its next poll.

## Ingress and TLS

Issue the certificate with cert-manager into a Secret, then reference that Secret from the route.
Never use an ingress controller's built-in ACME resolver alongside cert-manager — two things
requesting the same name is a rate-limit incident waiting to happen.

**DNS must resolve to the ingress before the certificate can issue.** An HTTP-01 challenge is solved
on port 80 of whatever the name points at. A workload that mounts the TLS Secret directly — a NATS
listener terminating its own TLS, for example — stays `Pending` until the first issuance lands, which
reads as "the deploy is broken" when it is really "DNS is not pointed yet".

Certificate renewal rewrites the Secret. An ingress controller re-reads it; a process that loaded it
at start does **not** — give that pod a config-reload sidecar or it will serve a stale certificate
until somebody restarts it, up to 90 days later.

## Pod hardening baseline

This repo's `docker/helm/` sets all of this. The chart `x new` writes sets the same keys, but its pod identity differs: `runAsUser`, `runAsGroup` and `fsGroup` all `1000`, where this repo's sets `runAsUser: 65532` and no group (`As of 2026-10`). What a test holds equal between the two is narrower — probes, the Service spec, the Secret a role reads, the bounded `/tmp` and the NetworkPolicy (`scaffold-helm-parity.test.ts`); the security context is held by neither. Keep it.

| Setting | Value | Why |
|---|---|---|
| `runAsNonRoot` / `runAsUser` | `true` / `65532` in **this repo's** chart; `true` / `1000` (plus `runAsGroup` and `fsGroup: 1000`) in the chart `x new` writes | each matches its own image (`As of 2026-10`): this repo's is distroless `nonroot`, 65532; a scaffolded app's is `oven/bun:1.4-alpine` with `USER 1000:1000`, the base image's `bun` user — one constant, `RUNTIME_UID` in [`scaffold-helm.ts`](../../packages/cli/src/templates/scaffold-helm.ts), read by both its Dockerfile and its chart. A hand-written manifest set reads the uid out of its own image (`docker run --rm <image> id -u`) rather than copying either number |
| `readOnlyRootFilesystem` | `true` | with an `emptyDir` at `/tmp`, **and** `ULTIMATE_STATE_DIR=/tmp/x` in the release's Secret: as of 2026-09-23 a boot still creates `.x/` (the embedded-state directory) whenever any binding is embedded — `NATS_URL` unset is one — and `/app/.x` is on the read-only root (plan 101 slice 12 k narrows it to an embedded database or disk) |
| `allowPrivilegeEscalation` | `false` | — |
| `capabilities.drop` | `[ALL]` | but see below |
| `seccompProfile` | `RuntimeDefault` | — |
| `terminationGracePeriodSeconds` | derived per role: `45` web/sync, `35` worker/scheduler/replicator, plus `roles.worker.retireSeconds` on the worker | preStop (5s, web/sync on 1.30+) + the readiness grace (`drain.readinessGraceSeconds`, web/sync only) + the worker's retire (`roles.worker.retireSeconds`, worker only) + the drain budget (`drain.deadlineSeconds` for every role but the worker; the worker's is `drain.workerDeadlineSeconds` when > 0, else `drain.deadlineSeconds`) + `drain.teardownMarginSeconds` (10s). Never set it by hand: `x deploy --method helm` passes those chart values from the app's own `drain` config (`deadlineMs` — every role's drain budget, web included, since 25.0.0 deleted `configureHttp`'s `drainTimeoutMs`; `workerDeadlineMs` — `ROLE=worker`'s in its place, up to a day, since 26.0.0; and `readinessGraceMs`, in seconds), so a raised budget raises its roles' grace with it. The `container` CI job refuses a value below 35 |
| `minReadySeconds` | `10` | a new pod must stay Ready this long before the rollout counts it and terminates an old one, so a role that passes its first probe and crashes seconds later never replaces a working pod. `maxUnavailable: 0`, `maxSurge: 1` on every rolling role |
| `roles.worker.retireSeconds` | `0` — off | the worker's opt-in retire (`As of 25.0.0`). Above 0, the worker gets a `preStop` that sends PID 1 SIGUSR2 and waits for it to exit: it claims nothing more, finishes every held job however long it runs, aborts nothing, logs `jobs.worker.retiring` / `jobs.worker.retired`, drains and exits 0 (`packages/cli/src/serve-retire.ts`). Set it to the longest a held job may run — for a job whose side effect may happen at most once and may outlast `drain.deadlineSeconds`; the seconds are added to the worker's grace period, which the kubelet counts the `preStop` against. Both charts, this repo's and the one `x new` writes ([Deployment](../../wiki/Deployment.md#retiring-a-worker-before-sigterm)) |
| `lifecycle.preStop.sleep` | `5`s, on Kubernetes 1.30+ only | holds SIGTERM while endpoints converge. The chart's floor is 1.27 and the field does not exist below 1.30, so it renders only where the API server knows it; below that the framework's readiness grace covers the same race |
| `startupProbe` | 30 × 5s | sized for an image with **no prebuilt store**, where a `web` pod runs Babel over every island and Sass over every stylesheet before its HTTP listener opens (4.2–4.8 s and 8–9 CPU-seconds on the demo app, `As of 2026-10-01`) — a liveness probe counting from container start restarts a pod that is merely booting. An image built from the scaffolded Dockerfile carries the store (`RUN … build --target prebuilt`) and is ready in 1.6–1.7 s; one that does not logs `X_IMAGE_NOT_PREBUILT` on every boot. The metrics listener opens first on every role, and the background roles build nothing either way |
| `ULTIMATE_CURSOR_SECRET` | in the release's Secret | a boot outside `development`/`test` on the development cursor key the framework ships is refused (`X_CURSOR_SECRET_DEV`) |
| `STORAGE_SIGNING_SECRET` | in the release's Secret, unless `S3_ENDPOINT`/`S3_BUCKET` select object storage | a boot outside `development`/`test` on the embedded disk with no real key is refused (`X_ENV_MISSING`). Both secrets are in the `# --- Framework` section `x env example` writes; `ULTIMATE_ENV=production x env check` against the Secret's values reports either one missing before a pod does |
| `tmp.sizeLimit` | `512Mi` on the `/tmp` `emptyDir` | an unbounded `emptyDir` is node disk: one pod filling it (the embedded-state directory above, a runaway upload) evicted its neighbours for disk pressure. Past the limit the kubelet evicts that pod alone. Raise it if `ULTIMATE_STATE_DIR` holds more; a values file with no `tmp.sizeLimit` refuses to render |
| `networkPolicy` | on, ingress only | one NetworkPolicy per role (`templates/networkpolicy.yaml`): `http` (web, sync) from `httpFrom` — any source until you name your ingress controller's namespace — and `metrics` from `metricsFrom`, any pod in the cluster and nothing outside it. Nothing else reaches a pod; kubelet probes are node traffic, which a policy never blocks. `egress` rules, when listed, turn on egress filtering with exactly those rules — list the database, NATS, the object store **and DNS**. Inert on a CNI that does not enforce NetworkPolicy |
| `roles.<role>.existingSecret`, `migrate.existingSecret` | unset: the release-wide `existingSecret` | name a narrower Secret per role so a compromised pod holds only what it reads — see [`02-secrets.md`](./02-secrets.md#one-secret-per-role) |

`capabilities.drop: [ALL]` is right for Ultimate's own image. It is not universally right: an
upstream image whose entrypoint drops its own privileges (via `setpriv` or similar) needs the
capability to do that, and dropping ALL breaks it at start with an error that does not say so.

## Placement

| Rule | Why |
|---|---|
| Pin stateless roles to general-purpose workers | control-plane nodes should not run app pods |
| Taint the node holding Postgres and the cache; tolerate it only from those workloads | a noisy app pod must not evict the database |
| Node-local volumes bind the pod to the node it first scheduled on | so a node-local PVC is a placement decision, not a storage decision |
| Never bind a host port you have not checked | a `hostNetwork` DaemonSet already owning a port makes a second one CrashLoop on exactly one node, so N-1 of N look healthy |

That last row is a real outage shape: a metrics exporter's default port collided with an ingress
controller's host-bound metrics port on the single public node. Four of five nodes reported fine.
The dashboard looked fine. One node was silently unmonitored.

## Naming

| Thing | Form |
|---|---|
| namespace, Service, image repo | RFC1123 — lowercase, hyphens, **no underscores** |
| Postgres database and role | **underscores** — `<app_with_underscores>` |

Those two forms differ, so a `sed` that renames the hyphenated slug does not touch the database
name. Check it by hand, every time.
