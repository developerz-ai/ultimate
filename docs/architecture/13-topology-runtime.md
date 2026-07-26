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
| `worker` | env → DB pool → one pool per `WORKER_QUEUES` entry | `/healthz` only | claim loop per queue, lease reaper, outbox relay | SIGTERM drain |
| `scheduler` | env → DB pool → `pg_try_advisory_lock` | `/healthz` only | tick loop (1s), lock retry loop if standby | SIGTERM, or lock loss |
| `migrate` | env → DB → advisory lock → apply | none | none | after apply — **exit 0 or non-zero, run-once** |
| `replicator` | env → advisory lock → open replication slot → NATS connect | `/healthz` only | WAL decode loop, matcher, publish, LSN confirm | SIGTERM, or lock held elsewhere |

Rules that keep this honest:

- No role holds durable state. Everything survivable is in Postgres, NATS, or object storage.
- `web` and `sync` are interchangeable to the load balancer except for protocol.
- A role that cannot get its lock **exits non-zero with a typed error** rather than running degraded.
- Any role can be co-located in one process for dev — role isolation is simulated, never skipped.
- Every role runs the same image and the same `x.manifest.json`, so the build ID is identical across the fleet.

## `/healthz` vs `/readyz`

Every role exposes both, on every replica. Both return a body — never a bare `200 OK`.

| Endpoint | Answers | Fails when | Consumer | Effect |
|---|---|---|---|---|
| `/healthz` | "is this process alive?" | event loop wedged, unhandled fatal state | liveness probe | **restart the container** |
| `/readyz` | "should traffic come here?" | DB unreachable, NATS down, migration/build mismatch, **draining** | readiness probe, LB | **remove from rotation** |

```json
{ "ok": true, "role": "sync", "buildId": "8f2a1c",
  "checks": [ { "name": "replication-lag", "ok": true, "value": "180ms" },
              { "name": "nats", "ok": true } ] }
```

| Role | `/readyz` additionally checks |
|---|---|
| `web` | DB pool healthy, build ID matches the applied migration version |
| `sync` | replication feed lag under threshold, NATS subscribed |
| `worker` | queue reachable, at least one pool claiming |
| `scheduler` | holds the leader lock — a standby reports **not ready, by design** |
| `replicator` | slot active, WAL lag under threshold |

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

| Consumer | Lock key | Held for | On loss |
|---|---|---|---|
| `scheduler` | `pg_try_advisory_lock(hashtext('ultimate:scheduler'))` | the DB session's lifetime | stop ticking immediately, report not-ready, retry acquisition every 5s |
| `replicator` | `ultimate:replicator:<db>` | same | exit non-zero with `X_REPLICATOR_SLOT_HELD` — a second replicator would double-deliver |
| `migrate` | `ultimate:migrate` | the migration run | `X_MIGRATE_CONCURRENT`, exit non-zero |
| ISR regen | short-lived Redis `SET NX PX` | 60s | another instance already regenerating; do nothing |

Session-level advisory locks, not a TTL table: a crashed process's connection dies and Postgres releases the lock. No heartbeat to miss, no lease to mis-tune, no split brain from a paused process — because a paused process's connection is still open and it still holds the lock, which is the correct answer.

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
| WS handshake | accepted, then a `build-stale` frame → signal flips; **the socket is not killed** |
| Job row enqueued by build A, claimed by a build-B worker | runs; the step memo is build-independent, and a removed step name fails loudly rather than silently skipping |

| Rule | Reason |
|---|---|
| `ROLE=migrate` must exit 0 before new `web`/`sync` start | a `web` replica whose build ID does not match the applied migration reports not-ready |
| Migrations are additive across one deploy | old and new code run simultaneously during a rollout; a destructive change needs two deploys |
| Skew is observable | `x status --json` reports the build-ID distribution of connected clients |
| No forced reload without a grace period | except `x deploy --critical`, which sets a countdown deadline and saves in-flight state through the mutator queue |

## Codes

| Code | Meaning | Fix |
|---|---|---|
| `X_CONFIG_INVALID` | env/config failed its schema at boot | `x doctor --json` |
| `X_MIGRATE_CONCURRENT` | another version's migration is in flight | wait, then `x db status --json` |
| `X_REPLICATOR_SLOT_HELD` | a second replicator for one database | scale `replicator` to 1 |
| `X_BUILD_SKEW` | client build incompatible with the current contract | client reload signal |
| `X_DRAIN_TIMEOUT` | in-flight work exceeded `DRAIN_TIMEOUT` | raise `DRAIN_TIMEOUT_MS` or shorten the step |
| `X_ROLE_UNKNOWN` | `ROLE` not in the union | set a valid role |
