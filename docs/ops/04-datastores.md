# Datastores in production

One Postgres, one cache, one message bus — many tenant databases. An app does not bring its own
database, its own Redis or its own broker onto a shared cluster. Pay the cluster-level cost once;
per-app cost is then a few YAML files.

The compose file in [`docker/docker-compose.dev.yml`](../../docker/docker-compose.dev.yml) exists so
`x dev` can talk to *real* services locally. It is not a production topology, and neither is
`x dev`'s embedded Postgres.

## Real numbers

Measured production values from an operator running this stack, `As of 2026-08`, on a 6-core / 12GB
node dedicated to state (tainted, so no app pod can be scheduled onto it). Start here, then measure.

| Workload | CPU request | Memory request | Memory limit | Volume |
|---|---|---|---|---|
| Postgres 18, single instance | `1` | `4Gi` | `6Gi` | `80Gi` node-local |
| Dragonfly (Redis-compatible cache) | `200m` | `4Gi` | `5Gi` | none — no snapshots |
| Connection pooler | `100m` | `128Mi` | `512Mi` | none |
| NATS + JetStream, single instance | `100m` | `256Mi` | `768Mi` | `10Gi` |
| — its config-reloader sidecar | `10m` | `16Mi` | `64Mi` | — |
| — its metrics exporter sidecar | `10m` | `32Mi` | `64Mi` | — |
| A typical serving app pod | `100m` | `384Mi` | `768Mi` | none |
| Prometheus | `200m` | `512Mi` | `1536Mi` | `20Gi` |
| kube-state-metrics | `20m` | `64Mi` | `192Mi` | — |

Postgres gets roughly half the node. The cache gets a third. Everything else lives in the remainder.
That ratio is the point of the table, more than the absolute numbers.

## Postgres

### Configuration that earned its place

| Parameter | Value | Why |
|---|---|---|
| `shared_buffers` | `3GB` | ~25% of the node, under the 4Gi request |
| `effective_cache_size` | `5GB` | tells the planner what the OS cache is likely holding |
| `work_mem` | `16MB` | per sort node, per connection — multiply by concurrency before raising it |
| `maintenance_work_mem` | `256MB` | vacuum and index builds |
| `max_connections` | `450` | see the arithmetic below |
| `wal_compression` | `on` | cheaper WAL on a node-local volume |
| `checkpoint_completion_target` | `0.9` | spread checkpoint I/O rather than spiking it |
| `random_page_cost` | `1.1` | SSD, not spinning rust |
| `log_min_duration_statement` | `500` | every statement over half a second, in the log |
| `track_io_timing` | `on` | makes `EXPLAIN (ANALYZE, BUFFERS)` tell the truth |
| `shared_preload_libraries` | `pg_stat_statements` | the only way to answer "what is slow" after the fact |
| `password_encryption` / `pg_hba` | `scram-sha-256` | md5 already accepted SCRAM verifiers, so the flip breaks no logins and is instantly revertible |

### Connection arithmetic

Ultimate sizes its pool **per role**, because a `worker` draining a queue and a `web` process behind
a CDN have different failure modes — [`packages/db/src/client.ts`](../../packages/db/src/client.ts):

| Role | Pool max | Statement timeout |
|---|---|---|
| `web` | 20 | 10s |
| `sync` | 10 | 10s |
| `worker` | 8 | 120s |
| `scheduler` | 2 | 15s |
| `migrate` | 1 | none — it takes as long as it takes |
| `replicator` | 4 | none |

So a modest fleet — 3 `web`, 2 `sync`, 2 `worker`, 1 `scheduler` — reserves `60 + 20 + 16 + 2 = 98`
connections at full saturation, from one app. At `max_connections: 450` that is four such apps
before the shared server is the constraint. **Do the multiplication before you raise an HPA
ceiling**, not after: an autoscaler that scales `web` to 30 asks for 600 connections on its own.

### Read replicas

`As of 2026-08-24`. A capacity tier, and it must never become a new way for the app to be down.

| Step | Operator's half |
|---|---|
| the pool | `DATABASE_REPLICA_URL` on every role that reads. Unset is one pool and the client is byte-identical to what it always was |
| the pool size | **the replica inherits the role's profile and `DATABASE_POOL_MAX`.** Redo the arithmetic above against **two** servers — a 3 `web` / 2 `sync` fleet reserves `60 + 20` on the primary *and* the same on the standby, so `max_connections` is a number each host needs |
| the scope | `withReplicaReads(fn)` in the app. Nothing routes without it, so setting the URL alone changes no traffic |

| Failure | What happens |
|---|---|
| the standby refuses a statement (`25006`) | re-run on the primary — exactly-once, because only plain reads are routed there and a refused statement never executed. Latency, never an error |
| the standby is down | the first three reads pay a doubled round trip, then the breaker parks it for **10 seconds** and every read goes to the primary. It re-tries after the cooldown |
| the URL points at a **writable** node | the safety net is gone. `25006` is what catches a statement the classifier could not vouch for; against a writable node a misroute becomes a write on the wrong server, silently. Point it at a standby or do not set it |
| replication lag | not a number this framework reads. Read-your-writes is closed by SCOPE (one write pins the rest of the scope to the primary), not by waiting on an LSN — so a read in a *different* scope can still see a lagging standby |

Watch `client.stats` (`replica`, `primary`, `fallbacks`, `parked`) and the `db.replica_fallback`
warning. A non-zero `fallbacks` that is not a deploy is the standby telling you something.

### Pooling, and the trap under it

A transaction-mode pooler hands a client a *different backend per transaction*. If the driver uses
named server-side prepared statements, a `PREPARE` and its `EXECUTE` can land on different backends
and the query fails with SQLSTATE **`26000` — prepared statement does not exist**. It is
deterministic once several backends are warm, and it looks like a driver bug until you know.

Ultimate queries through `Bun.SQL`'s `unsafe(text, values)` path — parameterised, not a named
server-side prepare — which is the shape that survives transaction pooling. **Verify it against your
Bun version before you pool in transaction mode.** If in doubt, session mode is correct and costs
you only multiplexing.

Three more pooler lessons, each paid for:

| Trap | What happens |
|---|---|
| Non-zero minimum pool size on a pool whose credential is not ready yet | The pooler eager-connects at **startup** and exits — taking down the pooler **for every tenant** because one tenant's password had not landed. Use lazy pools (minimum 0) for anything whose secret arrives asynchronously; a bad credential should fail that client, not the shared process |
| Credential rotation through the pooler | An app crash-looped ~5h on `28P01 password authentication failed` after being routed through the pooler, while the same password authenticated fine direct to the primary. The break was the pooler's copy of the credential, not the role |
| Unescaped substitution when rendering pooler config from secrets | A password containing a regex or delimiter metacharacter silently renders a *wrong* value. Escape before substituting, or the outage is a silent auth failure |

The blunt conclusion: **direct-to-primary is a legitimate answer** for a single-instance database
with headroom in `max_connections`. A pooler is a second stateful component in the critical path of
every query; add it when the connection arithmetic above says you need it, not by default.

## Dragonfly (Redis-compatible cache)

```
--maxmemory=4gb
--cache_mode=true
--save_schedule=          # deliberately empty: NO snapshots
--dbnum=1024
--proactor_threads=4
--requirepass=$(PASSWORD)  # from a secret; k8s expands $(...) in args at container start
```

| Decision | Reason |
|---|---|
| No snapshots at all | It is a cache. Everything in it is regenerable from Postgres. Snapshotting a cache buys you a slower restart and a backup you must not restore |
| `--maxmemory` set explicitly | Without it the process grows until the kubelet OOM-kills the pod, and an OOM kill of a cache reads as a mystery restart |
| Memory limit above `maxmemory` | `5Gi` limit against a `4gb` cap — the process needs headroom over its own accounting or the limit fires first |
| `strategy: Recreate`, one replica | Two replicas of a single-node cache is two caches |
| `--requirepass` even in-cluster | A per-app database *index* is logical isolation, not a security boundary. Any compromised pod can otherwise read and write every tenant's cache |
| Track index allocations in a committed file | Two apps silently sharing index `3` is a bug you find in production |

Alert on `used / max > 0.9` for 5m, computed as a ratio so one rule covers every instance regardless
of its individual cap. That metric name is worth verifying against a live scrape before you rely on
it — a wrong name is an alert that never fires.

Dragonfly serves its Prometheus metrics on its **main port** by protocol-sniffing, so the
`ServiceMonitor` targets the Redis port with `path: /metrics` and no separate metrics port.

## NATS with JetStream

Ultimate's `realtime` and `jobs` packages use NATS as the transport between nodes. One instance is a
legitimate production topology for a single-cluster app; clustering is a capacity decision, not a
correctness one.

| Setting | Value | Why |
|---|---|---|
| `jetstream.max_file_store` | `8GiB` under a `10Gi` volume | the file store must never be able to fill the volume it lives on |
| `jetstream.max_memory_store` | `256MiB` | with a `768Mi` container limit — headroom over the store plus server overhead |
| `terminationGracePeriodSeconds` | `60` | — |
| `preStop` | lame-duck mode | drain client connections *before* the TERM, or every subscriber sees a hard disconnect on every deploy |
| `readinessProbe` | `/healthz` on the monitor port | — |
| `livenessProbe` | `/healthz?js-enabled-only=true` | a server that is up but has lost JetStream is not alive for this purpose |

**Streams are created by the application, never by the server config.** The app declares what it
needs on connect. A stream defined in both places is a stream that drifts.

Three things that cost the operator real time:

**JetStream is off in the default image, and in decentralised-auth mode it must *also* be enabled
per-account.** Enabled server-side but not per-account, every call returns "JetStream not enabled" —
which reads as a client bug.

**The TLS certificate name forces the dial address.** A publicly-issued certificate can only carry
the public name, so in-cluster clients that verify TLS must dial the *public* hostname even from
inside the cluster. The internal Service then exists only for scraping and debugging. Plan for that
or you will have two TLS stories.

**A process that loads its certificate at start does not notice renewal.** NATS terminates its own
TLS from a mounted Secret. Certificate renewal rewrites the Secret; without a config-reload sidecar
signalling the server, it serves a stale certificate until somebody restarts the pod — potentially
months later.

## Backups

Daily logical dump, one object per database, to S3-compatible object storage. 7-day retention,
pruned in the same job.

| | |
|---|---|
| Schedule | `0 3 * * *` — off-peak |
| Format | `pg_dump --format=plain --no-owner --no-privileges`, gzipped |
| Key | `postgres/<db>/<YYYY-MM-DD>.sql.gz` — deterministic, so a restore never needs a lookup service |
| Retention | 7 days |
| Concurrency | `Forbid` — a backup that overlaps itself is a self-inflicted outage |

### The three things that make a backup real

**1. `set -o pipefail`.** Without it, `aws s3 ls | awk | while read` swallows a listing failure
entirely — `while read` always exits 0, `set -e` never fires, retention silently stops working, and
the bucket grows for weeks while the job reports green.

**2. Verify the stored object, not the exit code.** `pg_dump | gzip | aws s3 cp` **all exit 0 when
the dump truncates mid-stream**: gzip closes cleanly on early EOF and the uploader finalises the
partial. Re-read the stored object and assert its trailer:

```sh
aws s3 cp "s3://$BUCKET/$KEY" - | gunzip -c | tail -c 4096 \
  | grep -q "PostgreSQL database dump complete"
```

`tail -c` stays O(1) regardless of how long the last line is.

**3. On a failed verify, skip the prune for that database.** If today's dump is bad, retention must
not delete yesterday's good one. Sustained truncation otherwise erodes the bucket down to nothing but
unverifiable backups — the failure that turns a bad week into an unrecoverable one.

Conversely, a *listing* failure during prune should **not** fail the whole job: the dump is already
safe in object storage, and failing every other tenant's backup over one transient list error is a
worse trade. Log it, warn, continue.

### What is not backed up, deliberately

| | |
|---|---|
| The cache | regenerable from Postgres. Accepted risk, not an oversight |
| Point-in-time recovery | no WAL archiving — the daily dump is the only recovery point, so RPO is ≤24h rather than minutes. Add WAL archiving when 24h of loss stops being acceptable, and know that it is a second recovery path to test |

Restore, retention and the drill that proves any of this works: [`05-disaster-recovery.md`](./05-disaster-recovery.md).
