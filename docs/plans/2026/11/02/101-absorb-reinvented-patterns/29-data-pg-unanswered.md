# 29b — A statement nobody answers

> Part of [`overview.md`](overview.md). Depends on: none. [`29-data-pg-pooler.md`](29-data-pg-pooler.md) relies on the client-side bound here. Tier: 1 (`db`).

## Why
`statement_timeout` is the server's, so it cannot fire when the server or the path is gone. `acquireTimeoutMs` exists to stop "a wait with no end and no error" (`db/src/pool-reserve.ts:10`), and only `reserve()` reads it. Reproduced 2026-11-02, real pool:

| Probe | Printed |
|---|---|
| `max: 1`, one `pg_sleep(3)` running, `acquireTimeoutMs: 300`, plain statement | `ok` at 2964 ms. `reserve()` in the same state: `X_DB_POOL_EXHAUSTED` at 304 ms |
| TCP proxy blackholes the pool's 4 connections, as a node loss does; **the server is healthy and new connections reach it** | new statement `HUNG` at 25 s; `checkDb` (`/readyz`) `HUNG` at 15 s; connections opened: still 4 |
| server paused 20 s, plain statement | `HUNG` at 20 s |
| server `SIGKILL`ed and restarted | first statement after answers, 21 ms. Fine today, out of scope |

The second is the outage multiplier: after a failover the pod stays wedged for the kernel's retransmit window, about 15 minutes, on a database that is already back. `db/src/client.ts:92` races nothing. The request is answered 504 at 30 s (`http/src/pipeline.ts:201`), and the slot stays gone. Adopters run one Postgres in a cluster, so a node loss is the failure they will meet.

## Decisions
| Question | Answer |
|---|---|
| Which path gets the deadline | the pool path. A `SET LOCAL statement_timeout` can only raise the bound on a pin, and a statement on the pool path is always under the role's value. A pin dies with its pool, below |
| The number | `statementTimeoutMs + UNANSWERED_GRACE_MS` (5,000): past it the server's own bound had to have answered. `0` (`migrate`, `replicator`) has no deadline |
| What it costs per statement | no per-statement timer. One unref'd 1 s sweep per pool over an in-flight map: a read pays a map insert and delete |
| After a miss | **retire the pool.** The next statement builds a new one. Design check: `pool.close({ timeout: 1 })` returned at 1003 ms, the hung statement rejected `ERR_POSTGRES_CONNECTION_CLOSED`, a new pool answered on the same proxy |
| Why the whole pool | Bun.SQL does not expose one connection to close. A statement past that bound means a dead path, so its siblings on the same path are suspect too |
| A second breaker | no. `breaker()` stays deferred ([`90-deferred.md`](90-deferred.md)); this is a pool replacement, not a state machine, and `db/src/replica-client.ts:78` keeps its own |
| Which code | `X_DB_UNAVAILABLE`, new cause. An autocommit write may have landed, the same uncertainty as a connection closed mid-statement today |
| Kernel tuning instead (`tcp_retries2`) | not enough: the probe's path still ACKs, and it is a deployment setting nothing checks. A row in the ops doc as a complement |

## Files to change
- `db/src/pool-gate.ts` (new) — FIFO counter: `enter(acquireTimeoutMs)` waits only when `max` are out, rejects `poolAcquireTimeout` (`db/src/errors.ts:307`). `0` waits forever.
- `db/src/client.ts:92` — `run()` goes through the gate, registers in the sweep; `reserve()` (`:114`) holds a gate slot for the life of its pin, so one number counts both. `reserveWithin` keeps its timer for Bun's own queue.
- `db/src/pool-sweep.ts` (new) — `sweep(inFlight, deadlineMs, onMiss)`; `Scheduler` injected, as `cache/src/tiers.ts:259` does.
- `db/src/client.ts:84` — `retire()`: clears `driver` read-then-clear as `close()` does (`:188`), closes the old pool in the background with `{ timeout: 1 }`, rejection reported; logs `db.pool.retired` at error with the excerpt and elapsed.
- `db/src/errors.ts:193` — `statementUnanswered(excerpt, waitedMs)` over `dbUnavailable`.
- `docs/ops/04-datastores.md:50` — a row under connection arithmetic, `tcp_retries2` beside it. `docs/ops/06-runbooks.md`, `wiki/Error-Codes.md:260,268`, `packages/db/README.md`, `packages/db/CLAUDE.md`.

## Steps
1. The gate, unit first. `reserve()` and `run()` share it.
2. The sweep and `retire()`.
3. A retired pool's counter leaves `db_pool_max` through `demand.close()`, as `close()` does.
4. Measure the select path with `max: 4`, 20,000 sends, the method at `db/src/bun-sql.ts:97`. Put the number in the commit.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_DB_POOL_EXHAUSTED` (existing) | now also a plain statement past `acquireTimeoutMs` | existing |
| `X_DB_UNAVAILABLE` (existing) | no answer past the role's bound plus 5 s; the pool is replaced | existing, the cause names the bound and the excerpt |

No new code.

## Tests
- `db/src/pool-gate.test.ts`: FIFO order; a waiter past the bound rejects and leaves no slot; `0` waits. Mutation: skip the gate and the `client-pool` test fails.
- `db/src/client-pool.test.ts`: plain statement behind a full pool is `X_DB_POOL_EXHAUSTED` inside the bound. Fails today: `ok` at 2964 ms.
- `db/src/pool-sweep.test.ts`: fake `BunSqlDriver` never answers: the miss rejects, `connect()` builds a new driver, the old one saw `close({ timeout: 1 })`; `statementTimeoutMs: 0` never fires.
- `db/src/client-wedge.live.test.ts`: the proxy probe, inverted: statement rejects, the next answers, `checkDb` ok. Under `TEST_DATABASE_URL`, with `statementTimeoutMs: 500`.
- `bun test packages/db/src/pool-gate.test.ts packages/db/src/pool-sweep.test.ts`

## Semver
**Breaking, one row.** A plain statement that used to queue past `acquireTimeoutMs`, and succeed, now refuses, as a transaction already did.
Upgrading: "A plain statement behind a full pool answers `X_DB_POOL_EXHAUSTED` at `acquireTimeoutMs`: raise `DATABASE_POOL_MAX` or fix the slow statement. A statement unanswered past the role's bound plus 5 s is `X_DB_UNAVAILABLE` and the pool is replaced; an autocommit write may have landed."

## Done when
- The proxy probe recovers without a restart, inside the role's bound plus 7 s.
- The full-pool probe prints `X_DB_POOL_EXHAUSTED` near 300 ms.
- Measured per-statement cost stated in the diff; `bun run verify` green.
