# Topology runtime

One image, N roles. `ROLE` selects behavior at boot. No role-specific Dockerfile, no per-role dependency set, no drift between what you tested and what runs. Role rationale: [`../idea/11-topology.md`](../idea/11-topology.md).

```
docker build -t myapp .          # once
ROLE=web        myapp
ROLE=sync       myapp
ROLE=worker     myapp
ROLE=scheduler  myapp
ROLE=migrate    myapp            # pre-deploy hook
ROLE=replicator myapp
```

`ROLE` is a union in the env schema, so the role switch in `cli` is exhaustively checked — adding a role without wiring it does not compile ([`05-type-chain.md`](./05-type-chain.md)).

## Process model per role

| Role | Boot sequence | Listeners | Background loops | Exits when |
|---|---|---|---|---|
| `web` | env → DB pool → cache clients → route table → `Bun.serve` | HTTP on `PORT` | ISR regen consumer (optional), metric flush | SIGTERM drain |
| `sync` | env → DB pool (read) → NATS subscribe → `Bun.serve` upgrade handler | WS on `PORT` | policy-memo sweep, heartbeat/ping, buffer trim | SIGTERM drain |
| `worker` | env → DB pool → one pool per `WORKER_QUEUES` entry | `/metrics` only, on `METRICS_PORT` | claim loop per queue, lease reaper, outbox relay | SIGTERM drain |
| `scheduler` | env → DB pool → lease `acquire()` on `x_scheduler_leader` | `/metrics` only | tick loop (1s); `acquire()` per round is both the renewal and the standby retry | SIGTERM, or a round where the lease is not this holder's |
| `migrate` | env → DB → advisory lock → apply → post-migrate drift check | none | none | after apply — **exit 0 or non-zero, run-once** |
| `replicator` | env → advisory lock → open replication slot → NATS connect | `/metrics` only | WAL decode loop, matcher, publish, LSN confirm | SIGTERM, or lock held elsewhere |

Rules that keep this honest:

- No role holds durable state. Everything survivable is in Postgres, NATS, or object storage.
- `web` and `sync` are interchangeable to the load balancer except for protocol.
- `replicator` and `migrate` **exit non-zero with a typed error** rather than running degraded when their lock is held. `scheduler` is the exception by design: a node that does not hold the lease stays up as a warm standby and retries every round.
- Any role can be co-located in one process for dev — role isolation is simulated, never skipped.
- Every role runs the same image and the same `x.manifest.json`, so the build ID is identical across the fleet.

## What each role imports

A role imports what it runs. `ROLE_LOADS` in [`packages/cli/src/role-load.ts`](../../packages/cli/src/role-load.ts) is typed over `Role`, so a new role does not compile until it has a row. `As of 2026-10`.

| Role | App modules imported | Framework surface | Static modules, measured |
|---|---|---|---|
| `migrate` | none — it reads SQL files | the static graph of `serve-entry.ts` | 558 |
| `worker`, `scheduler` | `apps/web/api/index.ts` and what it imports, then every other module that reaches no `.tsx` and no stylesheet (`document-graph.ts`) | that, plus `serve-boot.ts` — the services and the roles — behind `serveApp`'s one `await import()` | 796 |
| `sync`, `replicator` | every module: a subscription names a live query and the slot decodes every entity's table, wherever either is declared | the same | 796 |
| `web` | every module `loadApp` would (`appModulePaths`) | the same, plus `serve-web.ts` — render's server half, islands, PWA, SEO, MCP — behind one more | 888 |

Before 2026-10-01 every role, `migrate` included, evaluated 869 (961 for `web`). What left the boot
graph: the `nats` client and its two dependencies (66 modules, loaded when a client is opened —
`nats-open.ts`), the schema-dump family (11, now `@ultimat3/db/schema-dump`), and — for `migrate`
— the services and the role boot (238).

| Rule | Held by |
|---|---|
| a job runs by name, so a `worker` must register every job | the gate requires every job and task to be named from `defineApi()` (`X_JOB_UNREGISTERED`); at boot the role checks `x.manifest.json`'s `jobs` and `tasks` against its registries and imports the whole app on a shortfall, logging `X_ROLE_LOAD_INCOMPLETE` |
| no manifest in the image | nothing to check against: the whole app is imported, with `fix: x manifest` in the log |
| `BUILD_ID` unstamped | the id is the manifest projection of the WHOLE app, so a `worker` imports every page to compute it — `x build --target docker` stamps it |
| a module that would not import | logged once per module at `error`, with its code, cause, `fix:` and file |
| no reload graph, no error-code walk | a container scans once: `scanAppModules(root, { track: false })` reads no module before importing it and hashes none |
| the static graph stays role-free | `serve-graph.test.ts` — no web-only module is statically reachable from `serve-entry.ts`, each role's module count is pinned (615 / 875 / 975), and `NEVER_AT_BOOT` lists what no role may evaluate before it is used |
| a declaration a worker never imports is a build error, not a boot surprise | the gate's `manifest` step imports the app as a worker does, in a child, then the rest module by module: a service, storage disk, catalog, entity, job, task, backfill, mail, layout or channel registered only by a module that reaches a document is `X_ROLE_LOAD_INCOMPLETE`, naming the module and the import `apps/web/api/index.ts` lacks (`verify-role-load.ts`). Costs the step ~150 ms: it runs beside the rest |

## The prebuilt store

A pod builds nothing at boot. `As of 2026-10-01`.

| Fact | Detail |
|---|---|
| what | every island chunk (`islands/`, verified by hash) and every compiled stylesheet (`sass/`, valid while every file the compile read hashes the same) |
| where | `node_modules/.cache/ultimate/` under the app root — in an image layer, readable under a read-only root. **Not `.x/`**: that is the state directory, which every ignore file drops and the compose topology mounts a tmpfs over |
| written by | `RUN bun node_modules/@ultimat3/cli/src/bin.ts build --target prebuilt`, in the Dockerfile's runtime stage, after `COPY . .` |
| why inside the image build | the store is valid for one Bun, one framework version and one set of absolute paths. A chunk built by the host's Bun is refused by the image's; a Sass entry is keyed by the sheet's path |
| why above `ENV NODE_ENV=production` | it imports the app with no deployment environment, and `app.config.ts` validates its env on import — in production it asks for values no image build has |
| why above `ARG BUILD_ID` | two images differing only by their stamp share the layer |
| read by | every role's boot (`adoptPrebuiltStyles`), before the first app module is imported; `web` reads the islands |
| absent or stale | the role builds what it needs and logs **one** `error` line, `X_IMAGE_NOT_PREBUILT`, with the chunk and stylesheet counts, the milliseconds, and the Dockerfile line |

Measured on the demo app's image (`oven/bun:1.4-alpine`, read-only root, tmpfs `.x`, `BUILD_ID`
stamped), `ROLE=web`, four boots each over two image builds:

| | time to ready | boot CPU | peak RSS | settled RSS | cgroup memory |
|---|---|---|---|---|---|
| no store | 4.2–4.8 s | 8.3–9.5 CPU-s | 244–269 Mi | 215–220 Mi | 176–179 Mi |
| prebuilt | 1.6–1.7 s | 1.8–2.0 CPU-s | 141–147 Mi | 97–102 Mi | 57–61 Mi |

The store is 400 kB for that app (83 stylesheets, no island); the step adds 4.5 s to `docker build`.

## Not built: one bundle per role

**The largest saving left, and a design decision rather than a patch.** Recorded `2026-10-01`;
tracked in [`wiki/Known-Gaps.md`](../../wiki/Known-Gaps.md).

| Measured 2026-10-01: the framework serve graph alone, no app | From source | One `bun build --target=bun` file |
|---|---|---|
| modules evaluated | 1,071 | 5 |
| settled RSS | 80.4 Mi | 51.8 Mi |

That is ~28 Mi per pod, or ~34 kB of resident memory per source module — which is why trimming
the module count (above) pays at all, and why it stops paying: the per-module cost is the
runtime's, not the code's.

| Constraint | Consequence |
|---|---|
| a registry is a module instance | bundling the framework apart from the app gives two instances of `@ultimat3/entity`, `@ultimat3/jobs` and every other registry: the app registers into one and the boot reads the other. `local-cli.ts` exists for exactly this failure |
| so the unit is app + framework | one graph, bundled at image build, per role — the web bundle carries the documents, the worker bundle does not (`ROLE_LOADS` already decides which) |
| the app is discovered by a scan, not by imports | `scanAppModules` globs `apps/*/{site,app,api,shared}`; a bundle needs a generated entry that imports what the scan would, in the scan's order |
| loaders run at build | `.tsx` and `.scss` go through the render loader as `Bun.build` plugins — the prebuilt store's work, moved into the bundle |
| axiom 7 | still containers only: the bundle is a build artifact inside the image, written by the same `RUN` step. Nothing platform-specific |
| axiom 6 | unaffected: this is the server graph; island chunks stay per-island |

Not attempted here: it changes what an image contains and how a role resolves its app, and the
module instance rule makes a half-measure worse than none.

## `/healthz` vs `/readyz`

**Only `web` and `sync` have them**, `As of 2026-08-22`. They are the two roles that construct an
HTTP server (`packages/http/src/server.ts`, `packages/realtime/src/sync-upgrade.ts`); `worker`,
`scheduler` and `replicator` open the metrics listener alone and are probed on `/metrics`. Both
endpoints return a body — never a bare `200 OK`.

| Endpoint | Answers | 503 when | Consumer | Effect |
|---|---|---|---|---|
| `/healthz` | "is this process alive?" | the lifecycle is `stopped`. **Ignores the readiness checks, deliberately** — a database outage that failed liveness fleet-wide would restart every pod into the same outage, cold | liveness probe | **restart the container** |
| `/readyz` | "should traffic come here?" | starting, draining, stopped, or any registered check answers `failing` | readiness probe, LB | **remove from rotation** |

The body is `{ state, ready, role }` for everyone; a peer in `healthDetailPeers` (default `['loopback']` — `kubectl exec`, a port-forward, the container's own probe) gets `HealthReport` plus the role, `As of 2026-10`. The status code never differs, and it is all a probe reads. On the `web` role; the `sync` node's own listener still answers the full report to any caller. `checks` is a **map** of check name → `ok` or `failing`, never an array — "alert on check failures BY CHECK NAME" is not writable against a boolean:

```json
{ "state": "ready", "ready": true, "uptimeMs": 41230, "inflight": 3,
  "buildId": "8f2a1c", "checks": { "database": "ok", "transport": "ok" },
  "registered": 2, "role": "sync" }
```

**`registered` is why readiness is not a boolean.** `checks: {}` reads identically for "every check
passed" and "nobody registered one", and an empty registry is still **ready** — deliberately, so a
role with a genuine absence of dependencies does not have to invent a check to boot.

| `registered` | `checks` | What a 200 means |
|---|---|---|
| `0` | `{}` | no more than "the socket is bound" — which is what the chart's and compose's healthchecks route traffic on |
| `n > 0` | every entry `ok` | every dependency this process owns answered |
| `n > 0` | any `failing` | not a 200: 503, and the body names the failing check |

`startServices` (`packages/cli/src/runtime-services.ts`) registers **at most two, and the count is
conditional**: `database` always, `transport` only when the transport can lose a connection. `x dev`
over the in-process bus reports `registered: 1`; a NATS-backed container reports `2`, which is the
body above. Read the name, never the number:

| Check | Registered when | Reads |
|---|---|---|
| `database` | always | the previous `db.ping()`, refreshed on read — staleness is one poll period, and the poll period is the operator's own `periodSeconds` |
| `transport` | only when the transport exposes a `connected` getter: NATS does, the in-process bus has nothing to be | `transport.connected`, synchronously |

`ReadinessCheck` is `() => boolean` and must stay that way — a probe that awaits its dependency
turns a slow dependency into a wedged endpoint and then a restart loop, which is the outage the
probe existed to prevent.

**Per-role checks are not registered by anything.** Replication lag, migration-version skew, "at
least one pool claiming", "holds the leader lease" — this page listed all five as shipped behaviour
until 2026-08-22 and none of them exists. A `scheduler` standby in particular does not report
not-ready, because it serves no readiness endpoint at all.

Confusing the two is the classic outage: a wedged-DB check on `/healthz` restarts every replica simultaneously during a database blip, converting a degraded read path into a total outage. Liveness must only fail for problems a restart fixes.

## Graceful drain on SIGTERM

Identical in every role. Deploys are the most common source of user-visible errors, so the drain is framework behavior, not a deployment guide.

```
SIGTERM
  1. /readyz → 503                    (LB stops sending new work; wait ≥ 2× probe interval)
  2. stop accepting new work          (HTTP: close listener; worker: stop claiming; sync: stop new subscribes)
  3. finish in-flight work            (bounded by DRAIN_TIMEOUT, default 30s)
  4. role-specific handoff            (see table)
  5. flush OTel spans + logs
  6. close pools, release advisory locks, exit 0
```

Ordering matters at every step:

| Step | Why it must be here |
|---|---|
| `/readyz` first | closing the listener before the LB notices produces connection-refused errors for in-flight routing decisions. The wait of ≥2× probe interval is what makes the drain invisible |
| stop accepting **after** the LB stops sending | otherwise a request arrives at a socket that is already closing |
| finish in-flight **before** handoff | a `sync` node must not send reconnect frames while still delivering patches; a worker must not release a lease mid-step |
| handoff **before** flush | the handoff itself emits spans worth keeping |
| locks released last | releasing the scheduler lock early would let a standby promote while this process still has a tick in flight |

| Role | Step 4 handoff |
|---|---|
| `web` | let in-flight requests and streaming responses finish; a stream past the deadline gets a typed truncation trailer, not a socket reset |
| `sync` | send every client a `reconnect` frame **with a per-client backoff delay**, then close cleanly |
| `worker` | finish the current step, persist it, release the job's lease so another worker resumes at the next step — never mid-step |
| `scheduler` | release the leader lock immediately so the standby promotes within one lock interval |
| `replicator` | flush the change feed to NATS up to the last confirmed LSN, then release the slot |

### Why `sync` sends reconnect-with-backoff

Closing 50,000 sockets at once means 50,000 simultaneous reconnects, all resubscribing, all asking "what changed since my LSN?" — during a deploy, when capacity is already reduced. It is fractal: surviving nodes overload, drop connections, and the herd re-forms.

```
{ type: 'reconnect', afterMs: 1830, resumeFrom: '0/1A2B3C4', reason: 'drain' }
```

| Property | Effect |
|---|---|
| Per-client `afterMs`, jittered over a window | reconnects arrive spread out, not as a spike |
| Window sized from live connection count | 500 clients drain in a second; 500k over minutes |
| `resumeFrom` LSN | reconnect is a delta from the change buffer, not a resubscribe-and-refetch ([`07-realtime-internals.md`](./07-realtime-internals.md)) |
| No sticky sessions | the LB redistributes clients across remaining nodes |
| Client backoff is a floor | a socket lost without a frame still backs off exponentially with jitter |

Result: a rolling restart produces a wide flat load curve instead of a spike.

## Leader election

**Two mechanisms, and which one a consumer gets is decided by whether it owns its connection.**

| Consumer | Mechanism | Held for | On loss |
|---|---|---|---|
| `scheduler` | a **row**: `SQL_LEADER_ACQUIRE` on `x_scheduler_leader`, key `scheduler`, holder a per-process uuid | `ttlMs`, default 30s; the per-round `acquire()` renews it | stop ticking; the next round's `acquire()` is the retry |
| `replicator` | `PgAdvisoryLock` — `pg_try_advisory_lock(hashtext('x:replicator:<slot>'))`, on a connection it owns | the session's lifetime | exit non-zero with `X_REPLICATOR_SLOT_HELD` — a second replicator would double-deliver |
| `migrate` | `pg_try_advisory_lock(4919202607)`, polled 500ms apart for up to 60s, on a reserved connection from a pool pinned to `max: 1` | the migration run | `X_MIGRATE_CONCURRENT`, exit non-zero — bounded on purpose, because blocking `pg_advisory_lock` has no timeout and hangs the deploy instead of failing it |
| ISR regen | short-lived Redis `SET NX PX` | 60s | another instance already regenerating; do nothing |
| jobs, per row | `FOR UPDATE SKIP LOCKED` at claim | the claim transaction | none — a locked row is skipped, not waited on |

The scheduler is the one that cannot use an advisory lock, and it is the executor that decides it:
`@ultimat3/jobs` is handed a **pool**, and a session-scoped grant is owned by the backend rather than
by the process: it outlives every transaction, and whether it survives the connection's return is
the pool's reset policy, not the caller's. Neither ending elects anybody. It shipped as
`pg_try_advisory_lock` and a rolling update double-fired every task. `@ultimat3/realtime` solves the same problem the other way — `PgAdvisoryLock`
owns its connection — because that package holds a wire protocol and jobs does not.

A crashed leader's lease is reclaimed by expiry, with nothing to clean up. That is the one property
the advisory lock had, and the one a plain `insert … on conflict do nothing` would not.

## Per-role autoscaling signals

| Role | Signal | OTel metric | Notes |
|---|---|---|---|
| `web` | requests/sec, p95 latency | `http.server.request.duration`, `http.server.active_requests` | classic HPA on RPS; latency as the guardrail |
| `sync` | concurrent connections | `sync.connections.active`, `sync.backpressure.bytes` | scale on connections, **not** CPU — an idle socket costs memory, not cycles |
| `worker` | queue depth + oldest-ready age | `jobs.queue.depth{queue}`, `jobs.queue.oldest_ready_ms{queue}` | age is the better signal: depth alone hides a stalled pool |
| `scheduler` | none | `scheduler.is_leader` | **fixed 1** + a standby. Never autoscaled |
| `replicator` | none | `replication.lag_bytes`, `matcher.cpu_ratio` | **1 per database**. Lag is an alert, not a scale-out |
| `migrate` | none | — | run-once |

Scaling `sync` on CPU is the common mistake: connections accumulate long before CPU moves, so the fleet undersizes until a fanout burst arrives and everything sheds at once.

## Build-ID propagation and version skew

The immutable build ID is a content hash of the build. **Never a timestamp, never `latest`.**

```
x build --target docker
  buildId 8f2a1c
    ├─ stamped into every asset path        /_x/app/i3.a91f.js
    ├─ stamped into sw.js + its cache namespace
    ├─ stamped into x.manifest.json
    ├─ emitted in every HTML document
    ├─ returned on /healthz, /readyz, and every response header
    └─ required on every client request     X-Ultimate-Build
```

| Hop | Carrier |
|---|---|
| server → browser | HTML meta + `X-Ultimate-Build` response header |
| browser → server (RPC, query) | `X-Ultimate-Build` request header |
| browser → `sync` | build ID in the WS handshake |
| server → worker | build ID column on the enqueued job row |
| role → role | the same image, so the fleet agrees by construction |

Skew handling during a rolling deploy:

| Request from build A while build B is current | Response |
|---|---|
| Asset within retention (N deploys, default 10, or 7d — whichever is longer) | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`; the SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query with a compatible contract | execute normally |
| Action / query whose input schema changed incompatibly | `X_BUILD_SKEW` with a `fix:` line |
| WS handshake | accepted, then an `update-available` frame → signal flips; **the socket is not killed**. The skew is the client's build (`?build=` on the dial, or the `hello` frame's `buildId` — read on every beat, and the latest is the record) against the node's, so a client learns of a deploy on the socket it opens against the new node — never on one already open |
| Job row enqueued by build A, claimed by a build-B worker | runs; the step memo is build-independent, and a removed step name fails loudly rather than silently skipping |

| Rule | Reason |
|---|---|
| `ROLE=migrate` must exit 0 before new `web`/`sync` start | a `web` replica whose build ID does not match the applied migration reports not-ready |
| Migrations are additive across one deploy | old and new code run simultaneously during a rollout; a destructive change needs two deploys |
| Skew is observable | `x status --json` reports the build-ID distribution of connected clients |
| No forced reload, at all | **`As of 2026-08` the framework force-reloads nothing, and no longer pretends to.** `x deploy --critical` was deleted in 4.0.0 (it recorded the intent in the plan JSON and nothing acted on it); 9.0.0 deleted the other half — `updateSignal`, `updatePolicy` and the three `AppUpdateAvailable` fields no producer emitted. Not deferred: **unwireable**, because the two runtimes that hold both build ids sit BELOW `pwa` in the tier table (`http` 2, `sync` 3, `pwa` 4) and imports only go down, so any caller would have inverted a tier or written a third copy of skew detection. Notification ships and is complete — the worker posts `{ type: 'AppUpdateAvailable', to }` and `useConnection().updateAvailable` reads it |

## Codes

| Code | Meaning | Fix |
|---|---|---|
| `X_CONFIG_INVALID` | env/config failed its schema at boot | `x doctor --json` |
| `X_MIGRATE_CONCURRENT` | another migrator still held advisory lock `4919202607` when the 60s wait budget ran out | `psql "$DATABASE_URL"` for the advisory-lock holder, terminate the wedged backend, then `x db migrate` |
| `X_REPLICATOR_SLOT_HELD` | a second replicator for one database | scale `replicator` to 1 |
| `X_BUILD_SKEW` | client build incompatible with the current contract | client reload signal |
| `X_SHUTDOWN_TIMEOUT` | graceful shutdown exceeded its deadline | `raise configureLifecycle({ deadlineMs })` or shorten the slow handler |
| `X_DRAINING` | work arrived after SIGTERM | retry against another replica; the LB should already have removed this one |
| `X_ROLE_INVALID` | `ROLE` is not a known runtime role | set `ROLE` to `web`, `sync`, `worker`, `scheduler`, `migrate` or `replicator` |
| `X_ROLE_LOAD_INCOMPLETE` | a worker or scheduler does not register what the whole app does — a finding from the gate, a logged fallback at boot | import the named module from `apps/web/api/index.ts`, or move the declaration out of the module that imports a component |
| `X_IMAGE_NOT_PREBUILT` | a role built island chunks or compiled stylesheets at boot | add `RUN bun node_modules/@ultimat3/cli/src/bin.ts build --target prebuilt` after `COPY . .` in the Dockerfile's runtime stage, rebuild |
