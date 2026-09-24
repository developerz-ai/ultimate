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
| `worker` | Deployment + a **headless** Service (no ClusterIP — it exists so a ServiceMonitor can select the `metrics` port) | HPA on queue depth, an `External` metric | liveness on `/metrics`, `:9090` — **no readiness** |
| `scheduler` | Deployment, `replicas: 1` | fixed — the leader is an expiring row in `x_scheduler_leader`, not an advisory lock | liveness on `/metrics`, `:9090` |
| `migrate` | Job, run-once before any serving role | 1 | none |
| `replicator` | Deployment, `replicas: 1` **per database** | fixed — holds a replication slot under a session advisory lock | liveness on `/metrics`, `:9090` |

**Probes follow the role, because the roles do not agree on what they open.** `web` and `sync`
construct a server and get `/readyz` + `/healthz` on it. `worker`, `scheduler` and `replicator`
construct none — their only socket is the metrics listener
([`packages/cli/src/metrics-endpoint.ts`](../../packages/cli/src/metrics-endpoint.ts)), which answers
`METRICS_PATH` and 404s everything else — so they get a liveness probe on `/metrics` and no readiness
probe at all. Probing `/healthz` on a port they never bound is the bug that made sync's readiness
probe meaningless; leaving them with no probe is how a wedged worker was never restarted.

A non-leader `scheduler` stands by: it holds no lease, dispatches nothing, and reports the same
liveness as the leader — there is no readiness signal to distinguish them. A second replica is
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
channel). To turn realtime on:

| # | Step |
|---|---|
| 1 | Declare the bus in `app.config.ts` — `realtime: { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' }` — then run NATS (JetStream on) and set the **same** `NATS_URL` for `web`, `sync` and the replicator. Both halves or neither: since 22.0.0 `'nats'` with the variable unset, and a `NATS_URL` under `'memory'`, each refuse the boot with `X_CONFIG_INVALID`; `enabled: false` starts no `sync` node and no replicator |
| 2 | Start Postgres with `wal_level=logical`, and create a publication for the entity tables (`CREATE PUBLICATION x_changes FOR TABLE …`, the replicator's preflight prints the exact statement); the replicator's role needs `REPLICATION` |
| 3 | Enable exactly one replicator per database: `roles.replicator.enabled: true` (chart) or a `ROLE=replicator` service (Compose) |
| 4 | Enable sync: `roles.sync.enabled: true`, or `replicas: 1` on the Compose `sync` service. The chart's Ingress routes `/_x/sync` only while sync is enabled |

## Migrations

Run them as a **pre-deploy Job**, gated before any serving role starts. The shipped chart already
does this (`helm.sh/hook: pre-install,pre-upgrade`, `hook-weight: -5`).

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

The shipped chart already sets all of this. Keep it.

| Setting | Value | Why |
|---|---|---|
| `runAsNonRoot` / `runAsUser` | `true` / `65532` | correct for **this repo's** distroless image. An app scaffolded by `x new` runs on `oven/bun:1.4-alpine` as user `bun` — read the uid out of your own image (`docker run --rm <image> id -u`) rather than copying 65532, or every pod fails to start |
| `readOnlyRootFilesystem` | `true` | with an `emptyDir` at `/tmp`, **and** `ULTIMATE_STATE_DIR=/tmp/x` in the release's Secret: as of 2026-09-23 a boot still creates `.x/` (the embedded-state directory) whenever any binding is embedded — `NATS_URL` unset is one — and `/app/.x` is on the read-only root (plan 101 slice 12 k narrows it to an embedded database or disk) |
| `allowPrivilegeEscalation` | `false` | — |
| `capabilities.drop` | `[ALL]` | but see below |
| `seccompProfile` | `RuntimeDefault` | — |
| `terminationGracePeriodSeconds` | `45` | must exceed preStop (5s) + the readiness grace (`drain.readinessGraceMs`, 5s outside local) + the drain deadline (25s) = 35s, or SIGKILL truncates in-flight work. The `container` CI job refuses a lower value |
| `lifecycle.preStop.sleep` | `5`s, on Kubernetes 1.30+ only | holds SIGTERM while endpoints converge. The chart's floor is 1.27 and the field does not exist below 1.30, so it renders only where the API server knows it; below that the framework's readiness grace covers the same race |
| `startupProbe` | 30 × 5s | a `web` pod builds the app's islands before its HTTP listener opens, so a liveness probe counting from container start restarts a pod that is merely booting. The metrics listener opens first on every role, and the background roles build no islands at all |
| `ULTIMATE_CURSOR_SECRET` | in the release's Secret | a boot outside `development`/`test` on the development cursor key the framework ships is refused (`X_CURSOR_SECRET_DEV`) |

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
