# Topology

One image, N roles. Build once; the `ROLE` env var selects behavior. No role-specific Dockerfile, no per-role dependency set, no drift between what you tested and what runs.

```
docker build -t myapp .          # once
ROLE=web       myapp             # ← same image
ROLE=sync      myapp
ROLE=worker    myapp
ROLE=scheduler myapp
ROLE=migrate   myapp             # pre-deploy hook
ROLE=replicator myapp
```

## Roles

| Role | Does | Scales on | Notes |
|---|---|---|---|
| `web` | SSR + static + RPC (actions/queries over HTTP) | **RPS** | behind CDN, stateless, N replicas, no local state |
| `sync` | live queries + fanout over WebSockets | **concurrent connections** | stateless, **no sticky sessions** — a client may reconnect to any node |
| `worker` | jobs + steps | **queue depth** | one pool per named queue; `WORKER_QUEUES=default,integrations` |
| `scheduler` | cron dispatch → enqueue only | **fixed 1** | Postgres advisory-lock leader election; a second instance is a warm standby, not a duplicate |
| `migrate` | run-once, pre-deploy | n/a | refuses to run if another version's migration is in flight (`X_MIGRATE_CONCURRENT`) |
| `replicator` | logical replication → change feed → matcher → NATS | **1 per database** | owns the replication slot; a second instance would double-deliver, so it takes an advisory lock and exits if held |

Rules that keep this honest:

- No role holds durable state. Everything survivable is in Postgres, NATS, or object storage.
- `sync` and `web` are interchangeable from the load balancer's perspective except for protocol.
- A role that cannot get its lock **exits non-zero with a typed error** rather than running degraded.
- Any role can be co-located in one process for dev ([`13-dx.md`](./13-dx.md)) — role isolation is simulated, not skipped.

## Health endpoints

Every role exposes both, on every replica.

| Endpoint | Answers | Fails when | Consumer |
|---|---|---|---|
| `/healthz` | "is this process alive?" | event loop wedged, unhandled fatal state | liveness probe → restart |
| `/readyz` | "should traffic come here?" | DB unreachable, NATS down, migration version mismatch, **draining** | readiness probe → remove from rotation |

| Role | `/readyz` additionally checks |
|---|---|
| `web` | DB pool healthy, build ID matches the migration version |
| `sync` | replication feed lag under threshold, NATS subscribed |
| `worker` | queue reachable, at least one pool claiming |
| `scheduler` | holds the leader lock (a standby reports not-ready, by design) |
| `replicator` | slot active, WAL lag under threshold |

Both return `{ ok, role, buildId, checks: [...] }` — machine-readable per [`09-ai-first.md`](./09-ai-first.md). Never a bare `200 OK` with no body.

## Graceful drain on SIGTERM

The sequence is identical in every role. Deploys are the most common source of user-visible errors, so the drain is framework behavior, not a deployment guide.

```
SIGTERM
  1. /readyz → 503                    (LB stops sending new work; wait ≥ 2× probe interval)
  2. stop accepting new work          (HTTP: close listener; worker: stop claiming; sync: stop new subscribes)
  3. finish in-flight work            (bounded by DRAIN_TIMEOUT, default 30s)
  4. role-specific handoff            (see table)
  5. flush OTel spans + logs
  6. close pools, release advisory locks, exit 0
```

| Role | Step 4 handoff |
|---|---|
| `web` | let in-flight requests and streaming responses finish; a stream past the deadline gets a typed truncation, not a socket reset |
| `sync` | send every client a `reconnect` frame **with a per-client backoff delay** (see below), then close cleanly |
| `worker` | finish the current step, persist it, and release the job's lease so another worker resumes at the next step — never mid-step |
| `scheduler` | release the leader lock immediately so the standby promotes within one lock interval |
| `replicator` | flush the change feed to NATS up to the last confirmed LSN, then release the slot |

### Why `sync` sends reconnect-with-backoff

Closing 50,000 sockets at once means 50,000 simultaneous reconnects, all resubscribing, all asking "what changed since my LSN?" That is a self-inflicted DDoS, and it lands during a deploy when capacity is already reduced. Worse, it is fractal: the surviving nodes get overloaded, drop connections, and the herd re-forms.

So the drain is **server-directed**:

```
{ type: 'reconnect', afterMs: 1830, resumeFrom: '0/1A2B3C4', reason: 'drain' }
```

| Property | Effect |
|---|---|
| Per-client `afterMs`, jittered over a window | reconnects arrive spread out, not as a spike |
| Server chooses the window from live connection count | 500 clients drain in a second; 500k spread over minutes |
| `resumeFrom` LSN | reconnect is a **delta from the change buffer**, not a resubscribe-and-refetch ([`03-realtime.md`](./03-realtime.md)) |
| Clients redistribute | the LB places them across remaining nodes; no sticky session to honour |
| Client-side backoff is a floor, not the mechanism | a client that loses the socket without a frame still backs off exponentially with jitter |

Result: a rolling restart is invisible to users and produces a wide, flat load curve instead of a spike.

## Millions of sockets

`sync`'s economics depend on per-connection cost, and that is where Bun's WebSocket implementation matters.

| Property | Effect |
|---|---|
| Sockets implemented natively (uWebSockets-derived), not as JS objects per connection | per-connection overhead is measured in **single-digit KB**, versus tens-to-hundreds of KB for a JS-object-per-socket runtime |
| Handlers are shared, not closures-per-socket | no per-connection closure graph for the GC to walk |
| Native pub/sub topics | fanout to a topic does not allocate per subscriber in JS |
| Backpressure exposed | a slow client is detectable and sheddable rather than an unbounded queue |
| Zero-copy message paths | broadcast cost scales with payload, not with JS object churn |

Measured, not assumed, `As of 2026-08`: **50,000 sockets on one `sync` node, survived a `SIGKILL` restart** — all 50,000 reconnected, 49,981 of them consistent inside the window, p50 54.0s / p90 105.5s, and 156,851 connect attempts shed by the `AcceptBudget` before reaching any query path ([`14-roadmap.md`](./14-roadmap.md#closed-the-50k-socket-forced-restart-benchmark)). That run was one node over `InProcessTransport`; NATS fanout was not in the path.

**Hundreds of thousands of concurrent subscribers per node remains a target**, not a result — 50k is the number this repo can show. What the measurement does settle is the shape of the cost: recovery is bounded by admission control, not by the matcher, so "realtime by default" is not the line item that decides your infra bill.

Caveats, stated: this is per-node capacity, not free. Live-query *matching* and fanout still cost CPU on the `replicator`, and memory per subscriber grows with subscribed-result size. `As of 2026-08`, long-running Bun processes are less battle-proven than Node's, and sustained-load memory profiling over hours — as opposed to one restart benchmark — has still not been done ([`15-risks.md`](./15-risks.md)).

## Deployment shape

| Concern | Answer |
|---|---|
| Image | one, built by `x build --target docker` ([`12-build-deploy.md`](./12-build-deploy.md)) |
| Config | env only, validated against a typed schema at boot — a missing key fails in ~40ms |
| Secrets | env or mounted file; the framework never talks to a vendor secret API |
| Migration | `ROLE=migrate` as a pre-deploy hook, must exit 0 before new `web`/`sync` start |
| Autoscaling signals | RPS (`web`), connection count (`sync`), queue depth (`worker`) — **emitted and scrapeable**; the cluster-side adapter is yours, see below |
| Platform primitives | none. Containers only ([axiom 7](./00-thesis.md)) |

### Autoscaling signals, honestly

`As of 2026-08`, the three signals above are **emitted, served and scrapeable**; only the cluster-side adapter is missing, and it was never the framework's:

| Piece | State |
|---|---|
| A metric API — counter, gauge, histogram on the OTel data model, a `MetricExporter` seam, and a Prometheus-text renderer | shipped — [`packages/core/src/metrics.ts`](../../packages/core/src/metrics.ts), [`metrics-text.ts`](../../packages/core/src/metrics-text.ts) |
| The three series the chart scales on, declared once so `roles.ts` and `docker/helm` cannot drift | shipped — `SCALING_METRICS` in [`packages/core/src/runtime-metrics.ts`](../../packages/core/src/runtime-metrics.ts): `http_requests_total`, `connections`, `queue_depth` |
| `recordRequest` / `recordConnection` / `recordQueueDepth` called from `http`, `realtime`, `jobs` | shipped — one call site each: `pipeline.ts`'s `finally`, `SocketRegistry.add`/`remove`, `worker.ts`'s `tick()`. `recordJob` is called too, once per settled attempt in [`worker.ts`](../../packages/jobs/src/worker.ts) |
| `METRICS_PATH` served by any role | shipped — every role, on `METRICS_PORT` (default 9090), not the role's HTTP port: the Helm ingress routes `/` with no path exclusion, so a metrics endpoint on 3000 would be public |
| The chart's half — a `metrics` containerPort on every role but `migrate`, that port published on the Service, a ServiceMonitor | shipped — [`_helpers.tpl`](../../docker/helm/templates/_helpers.tpl), [`service.yaml`](../../docker/helm/templates/service.yaml), [`servicemonitor.yaml`](../../docker/helm/templates/servicemonitor.yaml), the last behind `serviceMonitor.enabled` because a cluster without the Prometheus operator has no such CRD |
| A custom-metrics adapter in the cluster | never the framework's, and the chart does not ship one |

The call sites, the route and the chart's own port all landed, so [`docker/helm/templates/hpa.yaml`](../../docker/helm/templates/hpa.yaml)'s `rps`, `connections` and `queue_depth` have an emitter and a scrape target `As of 2026-08`. One piece is still not the framework's: a custom-metrics adapter turning scraped series into `Pods` metrics. An HPA pointed at an absent `Pods` metric sits at `<unknown>` and never scales, so install the adapter first. Turn the HPAs off and pin `replicas`, or supply the signals from outside the app; [`docs/ops/03-observability.md`](../ops/03-observability.md) is the operational half, and this doc does not repeat it.

Running an Ultimate app for real — Kubernetes, secrets, datastore sizing, disaster recovery, runbooks — is [`docs/ops/`](../ops/README.md). Recommendations, not framework dependencies.
