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

| Role | Pool max | Statement timeout | Idle in a transaction |
|---|---|---|---|
| `web` | 20 | 10s | 30s |
| `sync` | 10 | 10s | 30s |
| `worker` | 8 | 120s | 120s |
| `scheduler` | 2 | 15s | 120s |
| `migrate` | 1 | none — it takes as long as it takes | none |
| `replicator` | 4 | none | none |

A transaction idle past its bound is closed by the server, `X_DB_STATEMENT_FAILED` (`25P03`), which
frees the slot and its row locks past a handler's hung `await`. Do slow outbound work before opening
one.

So a modest fleet — 3 `web`, 2 `sync`, 2 `worker`, 1 `scheduler` — reserves `60 + 20 + 16 + 2 = 98`
connections at full saturation, from one app. At `max_connections: 450` that is four such apps
before the shared server is the constraint. **Do the multiplication before you raise an HPA
ceiling**, not after: an autoscaler that scales `web` to 30 asks for 600 connections on its own.

`max` is also what the client admits, statements and pins alike. What each bound does, `As of 2026-11-02`:

| Bound | Past it | What happens next |
|---|---|---|
| `acquireTimeoutMs` (5 s `web`/`sync`, 10 s `worker`/`scheduler`) | no slot free | `X_DB_POOL_EXHAUSTED`, for a plain statement as for a transaction: raise `DATABASE_POOL_MAX` or fix the slow statement |
| `statement_timeout` (the table above) | the server stops the statement | `X_DB_STATEMENT_TIMEOUT`; the pool is fine |
| the role's statement timeout + 5 s, plain statements only | no answer at all: the server or the path is gone | `X_DB_UNAVAILABLE`, `db.pool.retired` at error; **the pool is replaced**, the next statement opens a new one and a `LISTEN` is dialled again. Recovery inside the bound + 7 s, no restart. An autocommit write may have landed |
| `net.ipv4.tcp_retries2`, a node setting | the kernel gives up on a silent socket | about 15 minutes at the default `15`. Lower it (`8` is about 100 s) to bound what no statement watches: a transaction pinned while the gate still has room (pins that fill it, each past the bound, replace the pool on the next refused acquire). A complement, not the fix: a path that still ACKs never reaches it, and nothing checks the setting |

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
| replication lag | closed twice. Inside a request, by SCOPE: one write pins the rest of the scope to the primary. ACROSS requests, by position (`As of 2026-11`): a request that wrote answers with the primary's `pg_current_wal_lsn()` as a `__Host-x-pos` cookie and an `x-ultimate-position` header (30 s); the next request carrying either reads the standby only once its `pg_last_wal_replay_lsn()` (cached per process for 50 ms) has passed it. Behind, unknown or forged: the primary. Write, redirect, read shows the row |
| a bounded read (`query({ timeoutMs })`) | always the primary: it runs in a read-only transaction, and a transaction is pinned there |

Watch `client.stats` (`replica`, `primary`, `fallbacks`, `parked`) and the `db.replica_fallback`
warning. A non-zero `fallbacks` that is not a deploy is the standby telling you something.

### Pooling, and the trap under it

**`DATABASE_POOLER=session|transaction` says a pooler is in the path, and unset says none is.**
`As of 2026-11-02`: a switch and never a detection, because one pooler refuses libpq `options` at
startup and another accepts and drops them, so nothing fails to retry on. Every process reads it
once; one image, the URL and the switch change per environment. Another value refuses the boot
(`X_ENV_MISSING`).

| Path | `DATABASE_POOLER` | The bounds | What runs |
|---|---|---|---|
| direct | unset | sent as libpq `options` on every connection | every role, the wake |
| `pool_mode = session` | `session` | `alter role`, below | every role, the wake |
| `pool_mode = transaction` | `transaction` | `alter role`, below | `web`, `sync`, `scheduler`; `worker` on the poll. `migrate`, `replicator` and any step that applies a migration refuse before a socket: `X_DB_POOLER_SESSION_REQUIRED` |
| a stock pooler, switch unset | unset | refused: `X_DB_POOLER_OPTIONS_REFUSED`, on the first statement, every role | nothing, until the switch is set |
| a pooler that ignores `options`, switch unset | unset | **gone**: `statement_timeout = 0`. `X_DB_STATEMENT_BOUND_LOST`, one error line at boot and a `x doctor` finding, never a refusal | everything, unbounded |

Run once, direct to the server, per database user. Per-role bounds mean one database user per role,
with the numbers from the table under [Connection arithmetic](#connection-arithmetic):

```sql
alter role <user> set statement_timeout = '10s';
alter role <user> set idle_in_transaction_session_timeout = '30s';
```

**Then reopen the pooler's server connections.** A role setting applies at login, and a pooler holds
logins it opened before the `alter`: probed 2026-11-02, one pooler read back `10s` on a connection
opened after it, another read `0` on connections from its own boot. `x doctor --json` reads the
session in force: `data.statementBound`. With a pooler named, only a `0` on a role that has a bound
is reported, because one user may serve two roles.

**A statement queued in the pooler is not a dead one.** `statement_timeout` starts once the pooler
assigns a backend, so with a pooler named the client's unanswered-statement deadline (role bound +
5 s, then `X_DB_UNAVAILABLE` and a new pool) grows by `postgresClient({ poolerWaitMs })`, default
120 s — PgBouncer's `query_wait_timeout`. Set the two to the same number. A lost bound (`0`) still
leaves that deadline on the role's number: a healthy statement longer than it fails, and the pool
it ran on with it, which is one more reason to apply the `alter role` lines.

Both modes survive for the same reason: `prepare: false`
([`packages/db/src/bun-sql.ts`](../../packages/db/src/bun-sql.ts)) sends unnamed statements, so no
`PREPARE` is left on a backend the pooler has taken back, and SQLSTATE `26000` cannot occur. Transactions pin one
connection each, so `BEGIN`, its statements, `SET LOCAL` and `COMMIT` stay on one backend. Scheduler
leadership is a lease row, never an advisory lock, so it does not care. A session advisory lock
through a transaction pooler excludes nobody: two migrators both read `true` on one backend, and
that is why `migrate` is refused rather than warned.

**The job queue's wake does not cross a transaction-mode pooler.** A `worker` pod holds one
`LISTEN` session so a job another pod commits starts in milliseconds
([Jobs and workflows](../../wiki/Jobs-And-Workflows.md#idle-cost-and-pickup-latency)). In
transaction mode the `LISTEN` lands on a backend the pooler takes back at once and nothing is
ever delivered. Allowed all the same, because refusing would stop a fleet for a latency, and
`x doctor` says it on a `worker`: "wake off, pickup within `idlePollMaxMs`".

| Through | The wake | Pickup of a job another pod enqueued, worker idle | Idle claims a minute, per loop |
|---|---|---|---|
| direct, or `pool_mode = session` | proven: `jobs.wake.live` at boot | milliseconds | 12 |
| `pool_mode = transaction` | never proven: `jobs.wake.unverified`, once, at warn | within `idlePollMaxMs` — 2 s | 30 |

Nothing is lost either way: the poll is the guarantee and the wake only shortens it. To keep the
wake behind a transaction pooler, point the `worker` role's `DATABASE_URL` at the primary or at a
session-mode pool, with `DATABASE_POOLER` unset or `session` for that role — the session costs one
connection per worker pod, outside the role's pool.

Three more pooler lessons, each paid for:

| Trap | What happens |
|---|---|
| Non-zero minimum pool size on a pool whose credential is not ready yet | The pooler eager-connects at **startup** and exits — taking down the pooler **for every tenant** because one tenant's password had not landed. Use lazy pools (minimum 0) for anything whose secret arrives asynchronously; a bad credential should fail that client, not the shared process |
| Credential rotation through the pooler | An app crash-looped ~5h on `28P01 password authentication failed` after being routed through the pooler, while the same password authenticated fine direct to the primary. The break was the pooler's copy of the credential, not the role |
| Unescaped substitution when rendering pooler config from secrets | A password containing a regex or delimiter metacharacter silently renders a *wrong* value. Escape before substituting, or the outage is a silent auth failure |

The blunt conclusion: **direct-to-primary is a legitimate answer** for a single-instance database
with headroom in `max_connections`. A pooler is a second stateful component in the critical path of
every query; add it when the connection arithmetic above says you need it, not by default.

### Roles under row security (`As of 2026-11-06`)

With `database.rowSecurity: true` in `app.config.ts` (off by default) Postgres refuses another
tenant's row on its own, under the repository's check — but only to a role it does not exempt. So
the database needs two roles, and which is which is the deployment's job.

| Role | Attributes | Runs | Framework name |
|---|---|---|---|
| migrator | `nosuperuser bypassrls`, owns every table | `ROLE=migrate`, `x db migrate` | `x_migrator` on PGlite and the test services |
| app | `nosuperuser nobypassrls`, owns nothing, DML grants only | every serving role: `web`, `worker`, `scheduler`, `sync` | `x_app` on PGlite and the test services |

| Where | Who picks the roles |
|---|---|
| PGlite (`x dev`, `x db migrate` with no `DATABASE_URL`) | the framework: it creates both, the migrate step holds `x_migrator` (taking over what PGlite's superuser already owned in `public`), and `x dev` serves as `x_app` |
| test services | `acquireWorkerDatabase({ rowSecurity: true })`: migrated as `x_migrator`, the suite's URL is `x_app` |
| production | **the operator.** The names are yours; the boot never reads one. `ROLE=migrate`'s `DATABASE_URL` is the migrator, every serving role's is the app role. Grants on every table, the `x_*` ones included, are yours too (`alter default privileges for role <migrator> … to <app>`) |

`X_DB_ROW_SECURITY_BYPASSED` is the boot refusing to serve as a role Postgres would exempt — a
superuser, a `bypassrls` role, or the owner of a tenant table — because under that role every
policy refuses nothing and the guard would be a decoration. Not a crash to retry: point the serving
role's `DATABASE_URL` at the app role, or `psql "$DATABASE_URL" -c 'alter role <role> nosuperuser
nobypassrls'`. `x doctor` connects as `DATABASE_URL` and reports the same verdict without booting.
The migrator is exempt on purpose: a backfill or a constraint validate must still see every row.

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
