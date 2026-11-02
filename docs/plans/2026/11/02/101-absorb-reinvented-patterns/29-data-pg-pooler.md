# 29a — Postgres through a connection pooler

> Part of [`overview.md`](overview.md). Depends on: [`29-data-pg-unanswered.md`](29-data-pg-unanswered.md) (the client-side bound on either path). Tier: 1 (`db`), 5 (`cli`).

## Why
`docs/ops/04-datastores.md:96` says the driver "survives transaction pooling" and to verify it. Verified 2026-11-02, Postgres 18, Bun 1.4.4, real `postgresClient`, two poolers in their stock config:

| Path | Printed |
|---|---|
| direct | `statement_timeout = 10s` |
| pooler A, session or transaction | `X_DB_STATEMENT_FAILED … [08P01] unsupported startup parameter in options: statement_timeout — statement: show statement_timeout`. Every role, first statement |
| pooler A, parameter added to its ignore list | connects; `statement_timeout = 0`. The role's bound is gone, silently |
| pooler B, transaction | connects; `statement_timeout = 0`, silently |
| two `migrate` clients through a transaction pooler, `pg_try_advisory_lock` on a pin | `got: true` for both, one backend. The migration lock excludes nobody |

Cause: `db/src/connection-url.ts:89,98` always sends the bound as libpq `options`. Three adopters' deploy docs say direct, not through the pooler; a fourth lists the pooler as a dependency; the operator's other stacks run through one. `docs/idea/17-scale-ladder.md:246` puts a pooler on rung 2.

**Idle in a transaction (K1b).** Direct, `web` role: `show idle_in_transaction_session_timeout` prints `0`, beside a statement bound of `10s`. A handler awaiting a hung call inside a transaction holds a pooled slot and its row locks past the request's 504; nothing server-side ends it.

**`LISTEN`.** Probed 2026-11-02, real `postgresClient` and `startQueueWake`, both poolers in transaction mode: `listen` resolves, `onListening` fires, a `pg_notify` through the pool crosses `0` times. Direct and session mode: `1`, `live() true`.

## Decisions
| Question | Answer |
|---|---|
| Detect the pooler by a retry without `options` | no. A second connect path, and pooler B accepts and drops, so nothing fails to retry on |
| The switch | `DATABASE_POOLER=session\|transaction`, unset is today's bytes. Env, as `POOL_MAX_ENV` (`db/src/pool-profile.ts:108`): one image, the URL changes per environment |
| Where the bound lives then | the server: `alter role <user> set statement_timeout = '10s'`, applied at the pooler's own server login. Per-role bounds mean one database user per role, in the table of `docs/ops/04-datastores.md:55`. [`29-data-pg-unanswered.md`](29-data-pg-unanswered.md) keeps a client-side bound on either path |
| Which roles may use transaction mode | not `migrate` and not `replicator`: session advisory locks and replication need one backend. Refused at boot, never a silently shared lock |
| `worker` under transaction mode | allowed, and it falls back. Not silent, and no new code: `startQueueWake` proves the path with a notification through the pool (`jobs/src/queue-wake.ts:116`), and after 5 s logs `jobs.wake.unverified` once, at warn (`:133`). `queue_wake_live` stays 0 (`cli/src/role-wake.ts:27`), and the loops keep the 2 s idle ceiling instead of 5 s (`jobs/src/idle-backoff.ts:14,21`). Cost: pickup up to 2 s late, 30 idle claims a minute per loop against 12 (`docs/ops/04-datastores.md:107-110`). No job is lost: the poll is the guarantee. Refusing would stop a fleet for a latency. The wake needs a session: that role's `DATABASE_URL` on the server or a session pool, `DATABASE_POOLER` unset or `session` |
| Scheduler leadership | unaffected. A lease row in `x_scheduler_leader`, never an advisory lock (`jobs/src/scheduler.ts:5`, wired at `cli/src/role-start.ts:362`) |
| Idle-in-transaction bound | `PoolProfile.idleInTransactionMs`: `web`, `sync` 30 s, `worker`, `scheduler` 120 s, `migrate`, `replicator` 0. Sent beside `statement_timeout`; with a pooler set, in the `alter role` line instead. Probed through a transaction pooler: both `alter role` values read back (`700ms`, `10s`) on a connection opened after the `alter`. The second pooler printed `0`, `0` on connections it opened at its own boot, before the `alter`; a new role setting needs the pooler's server connections reopened, and the ops table says so |
| A dropped bound with no switch set | one error line at boot and a `x doctor` row. Not a refusal: a fleet already running this must not stop on upgrade |

## Files to change
- `db/src/pool-profile.ts:11,49,108` — `idleInTransactionMs` on `PoolProfile` and `POOL_PROFILES`; `POOLER_ENV`, `poolerFromEnv(env)`; an unknown value refuses as `POOL_MAX_ENV` does.
- `db/src/connection-url.ts:89,98` — `idle_in_transaction_session_timeout` beside `statement_timeout`; a pooler set: neither, the operator's own `options` stay, an empty one is not emitted.
- `db/src/default-client.ts:31` — reads the pooler once, hands it to both `postgresClient` calls.
- `db/src/client.ts:58` — `PostgresClientOptions.pooler`; refuses `migrate`/`replicator` under `transaction`.
- `db/src/errors.ts:249` — `driverError`: `08P01` with `unsupported startup parameter` is the new code, not `X_DB_STATEMENT_FAILED`. SQLSTATE `25P03` stays `X_DB_STATEMENT_FAILED`, its cause and fix naming the handler's slow await.
- `db/src/db-health.ts` — `statementBound(client)`: reads both settings, answers `{ applied, expected }` per setting.
- `cli/src/runtime-services.ts` — one boot call; logs `X_DB_STATEMENT_BOUND_LOST` once when applied differs from the profile, or, with a pooler set, when it is 0.
- `cli/src/doctor-pooler.ts` (new), `cli/src/cmd-doctor.ts:15` — the same fact on demand, and on a `worker` with `DATABASE_POOLER=transaction` the row "wake off, pickup within `idlePollMaxMs`".
- `jobs/src/queue-wake.ts:52` — `UNVERIFIED_FIX` also says to unset `DATABASE_POOLER` for that role.
- `docs/ops/04-datastores.md:89-126` — replaces the "verify it" paragraph with a table per mode; `:96` also misstates the mechanism, the answer is `prepare: false` (`db/src/bun-sql.ts:106`). `:101-113` keeps the wake table, gaining the switch. `wiki/Deployment.md`, `wiki/Upgrading.md`, `wiki/Error-Codes.md`, `packages/db/README.md`, `packages/db/CLAUDE.md`.
- `docker/docker-compose.test.yml`, `docker/test-services.env`, `scripts/test-services-shape.test.ts` — a pooler service, `TEST_POOLER_URL`. Unset skips, as every live suite does. No package dependency.

## Steps
1. Codes, `bun run new-error-code`.
2. `poolerFromEnv`, then `connectionUrl`.
3. `driverError` classification.
4. The role refusal in `postgresClient`: thrown at construction, before a socket.
5. `statementBound` and the boot line.
6. Doctor row, ops table.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_DB_POOLER_OPTIONS_REFUSED` (new, `db`, `--status 503`) | the pooler rejected libpq `options` at startup | `DATABASE_POOLER=transaction`, then in psql direct to the server: `alter role <user> set statement_timeout = '10s'; alter role <user> set idle_in_transaction_session_timeout = '30s'`, then reopen the pooler's server connections |
| `X_DB_POOLER_SESSION_REQUIRED` (new, `db`, `--off-socket`) | `migrate` or `replicator` under `DATABASE_POOLER=transaction` | point this role's `DATABASE_URL` at the server's own port, and unset `DATABASE_POOLER` for it |
| `X_DB_STATEMENT_BOUND_LOST` (new, `db`, `--off-socket`) | logged: the session's `statement_timeout` or `idle_in_transaction_session_timeout` is not the role's | the same `alter role` line, or `DATABASE_POOLER` if a pooler sits in the path |
| `X_DB_STATEMENT_FAILED` (existing) | SQLSTATE `25P03`: the server closed an idle transaction | do slow outbound work before opening the transaction |
| `X_ENV_MISSING` (existing, core's) | `DATABASE_POOLER` holds another value | `DATABASE_POOLER=session` or `transaction`, or unset it |

## Tests
- `db/src/connection-url.test.ts`: unset is byte-identical but for the new setting, per role; `transaction` carries neither bound and keeps `-c search_path=app`. Mutation: drop the branch.
- `db/src/errors-pooler.test.ts`: a fabricated `08P01` of that text maps to the code; another `08P01` stays `X_DB_STATEMENT_FAILED`.
- `db/src/client-pooler.test.ts`: `migrate` under `transaction` refuses before any socket; under `session` passes.
- `db/src/pooler.live.test.ts`: the table above, inverted: bare URL gives the new code; `DATABASE_POOLER=transaction` runs a statement, a `withTransaction`, a `readOnlyQuery`, and `statementBound` reports 0.
- `jobs/src/queue-wake-pooler.live.test.ts`: through a transaction pooler `live()` is false, `jobs.wake.unverified` fires once, an enqueued job is still claimed within the ceiling. Fails if the fallback is removed.
- `db/src/client-idle-tx.live.test.ts`: idle transaction past a 200 ms bound; the slot returns, the next statement answers.
- `cli/src/doctor-pooler.test.ts`.
- `set -a; . docker/test-services.env; set +a; bun test packages/db/src/pooler.live.test.ts`

## Semver
**Breaking, one row (K1b).** `PoolProfile` gains a required member and `POOL_PROFILES` changes; both are exported, and a transaction that used to idle forever now dies.
Upgrading: "A transaction idle past 30 s (`web`, `sync`) or 120 s (`worker`, `scheduler`) is closed by the server, `X_DB_STATEMENT_FAILED`: do slow outbound work before opening it. A hand-built `PoolProfile` adds `idleInTransactionMs`. Behind a pooler, set both bounds with `alter role`, as `X_DB_POOLER_OPTIONS_REFUSED` prints." `DATABASE_POOLER` unset changes nothing else in the URL. New: one error line at boot on a fleet whose bound is already gone.

## Done when
- `bun run x -- doctor --json` reports the applied bound through a pooler.
- A fresh app with `DATABASE_POOLER=transaction` and the printed `alter role` serves through a transaction pooler, bound non-zero.
- `ROLE=migrate` through a transaction pooler refuses with the new code.
- `ROLE=worker` through one boots, runs jobs on the poll, and `x doctor --json` says the wake is off.
- An idle transaction on `web` ends at 30 s, direct and through a pooler after `alter role`.
- `bun run verify` green.
