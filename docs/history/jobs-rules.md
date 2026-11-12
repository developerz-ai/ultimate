# jobs: rule text moved out of `packages/jobs/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file toward a 20 KB working target (the
enforced ceiling is 24,576 B, `bun run scripts/claude-md-size.ts`). Each section below is a bullet
as it stood, verbatim; the package file keeps a one-line rule marked `†`. Where the two disagree,
`packages/jobs/CLAUDE.md` wins. The older long form is [`jobs.md`](jobs.md).

## `enqueueMany`

- **`enqueueMany` is one statement per `ENQUEUE_CHUNK` (1,000)** (`job-enqueue-many.ts`;
  `SQL_ENQUEUE_MANY`: `SQL_ENQUEUE`'s conflict target and id fence, one wake per queue); skipped rows
  are answered by ONE `SQL_ENQUEUE_MANY_RESOLVE`, a row neither answers goes back through `enqueue`.
  **`JobDriver.enqueueMany` is REQUIRED** and opens with `assertEnqueueMany` (no `onConflict:
  'error'` in a batch, `X_INVARIANT`); Redis's `REDIS_ENQUEUE_MANY` shares `enqueue_one` with
  `REDIS_ENQUEUE`. `OutboxStore.stageMany`/`markPublishedMany` are OPTIONAL: absent, a loop. Every
  refusal precedes the first write; `refuseAbandoned()` before every direct chunk. `runAt` crosses
  as `numeric` then `bigint`: a fractional ms rounds, never a `22P02`.

## Drivers and `redisJobDriver`

- Drivers: the `JobDriver` methods plus optional `introspect`, `backfills`, `leases`; new
  capabilities go behind the interface. **`redisJobDriver`** (`@ultimat3/jobs/redis`, off the
  barrel) is one Lua script per operation: a semantic change lands in memory, pg AND the scripts.
  Its client is core's `redisClient()`, never `Bun.redis`; `ERR_REDIS_CONNECTION_CLOSED` is
  `X_DRIVER_UNAVAILABLE` at once (`typedRefusals`), never a wait.

## Settlement is fenced

- **`ack`, `nack`, `heartbeat` and `recordProgress` are FENCED on `state = 'running'` AND the
  CLAIM** — `{ workerId, claim }`, `claimOf(claimed)`; `x_jobs.claims` is moved by the claim and
  never reset. `heartbeat` answers a boolean, read as `held === false` (never `!held`).

## The claim buries an exhausted lease

- **The claim BURIES a lease that lapsed on the final attempt** (`attempt >= max_attempts`): `dead`
  in `SQL_CLAIM` — `failed` for a name in `ClaimOptions.dropExhausted` (`retry.deadLetter: false`)
  — counted, never returned; the worker's round hears `onExhausted` and calls `announceExhausted`.

## `whenBusy: 'fail'`

- **`whenBusy: 'fail'` refuses only on EVIDENCE another run holds the key** (`LeaseStore.holders`,
  required): a run meets its own leftover slot. The refusal is `nack({ fail, countsAsAttempt:
  false })` → `failed`, outcome `refused` (`worker-key-busy.ts`), never `executeJob`.

## A deploy lets a running job finish

- **A deploy lets a running job FINISH**: SIGTERM only stops claiming. `drainSignal` aborts
  (`X_DRAINING`) at `deadlineAt − margin` (`worker-drain-cutoff.ts`), then held claims go back
  uncounted (`worker-held.ts`). Settles **`interrupted`**; `docs/history/jobs.md`, "Drain, 2026-10".

## Fleet slots

- **A fleet slot is taken INSIDE a `try`, released AWAITED, and HELD, not owned**: `false`, or a TTL
  with no renewal landing, CANCELS the run (`X_JOB_SLOT_LOST`); held per job id as a LIST.

## Leases

- **A lease is HELD, not owned** (`heartbeat.ts`): one failed renewal warns; a whole window without
  one landing is `jobs.lease.lost`, on this process's clock, asked both sides of the call.

## Abandon, never release

- **A lease for a run that never STARTED is `abandon()`ed, never `release()`d** — the rate stamp
  goes with it (`worker-admit.ts`). **A failed pass re-arms at the floor** (`worker-loop.ts`
  catch); `timers` is the test seam.

## `step.run` hydration

- **`step.run` hydrates the run's steps from ONE `store.list(runId)`**; `sleep` and `waitForEvent`
  record replays through `trace()`. **`claimName` reads a Set**; `usedNames()` keeps
  `MAX_TRACE_NAMES` (200).

## Staged row ids

- **A staged row's id IS its job's id, and its `runId` is allocated at stage** (`x_outbox.run_id`):
  a staged enqueue answers real ids. `SQL_ENQUEUE` inserts nothing under an id that names a row —
  a repeated publish is `deduped`, live or finished (`outbox-run-id.test.ts`).

## Relay batches

- **The relay publishes a batch in two statements** (`publishBatch`): `driver.enqueueMany`, then
  `markPublishedMany` if the store has it; any failure drops that batch to the order-keeping row loop.
  `RELAY_BATCH_SIZE` (500) is measured in its doc comment.

## Relay drain

- **The relay drains in two phases**; `relay.stop()` JOINS the pass in flight, under a `DrainBudget`
  a later shutdown binds LATE (the worker's shape); its timer is `unref`ed.

## Backfill ledger vs registry

- **The ledger says what RAN, the registry what EXISTS, `backfill-pending.ts` is the diff.**
  `environments` is checked in `backfillPass()` and `gateBackfill()`; `requires` in `gateBackfill()`
  only; `count` after the last batch (`X_BACKFILL_STALLED`). `inspectBackfills()` is the ONE projection.

## `importRows()`

- **`importRows()`**: one step per PAGE, checkpointed at the BYTE OFFSET, no carry between steps;
  `pageBytes` > `maxRecordBytes` is refused at declaration. `handle` is AT LEAST ONCE per page. The
  error report never carries the refused value. NO cross-tenant escape.

## `webhookReceiver()`

- **`webhookReceiver()`**: a plain `Route` read under `maxBytes` (core's `readWithinLimit`, never
  `bodyBytes()`); `verify` runs before any parse and answers `{ eventId, payload }` from verified
  data; the id is bounded (`WEBHOOK_EVENT_ID_PATTERN`, 422); the enqueue is `outbox: false` before
  the ack (503 otherwise); the payload is stored `.sensitive()`, never re-verified.
  `webhookReceiverRoutes()` is what the boots mount.

## `webhook()`

- **`webhook()`**: ONE event to ONE endpoint, no steps; each attempt but a CANCELLED one recorded
  before the throw; `ledger.isDisabled` gates the socket. **The wire format is core's.** An org
  tenant reads `orgId` OFF THE INPUT; none, or not the run's org: TERMINAL `X_JOB_TENANT_MISMATCH`.

## Files rows merged: `backfill-*.ts`

| File | Owns |
|---|---|
| `backfill-pass.ts` | one pass: the batched iteration, its cursor checkpoints and its ledger row |
| `backfill-scope.ts` | which sweeps run across tenants (`tenant: 'none'` only) |
| `backfill-ledger.ts` | `x_backfills` — the contract, `BACKFILL_STATUSES`, the checksum, the verdict, the memory ledger |
| `backfill-registry.ts` | what was DECLARED: the `origin` stamp, `isBackfill`, `registeredBackfills` |
| `backfill-gate.ts` | may this sweep run here and now — environment, `requires`, already-applied |
| `backfill-pending.ts` | declared minus completed, per environment: the alarm `--pending` reads |
| `backfill-rate.ts` | the `rate` throttle: batches/sec as an interval, and the cancellable wait |
| `backfill-inspect.ts` | the ledger projected for `x db backfill`, `x jobs`, `/_x` and MCP |
| `backfill-errors.ts` | the eight `X_BACKFILL_*` classes; the codes stay declared in `error-codes.ts` |
| `backfill-definition.ts` / `-source.ts` / `-reader.ts` | the declaration types; exactly one of `source`/`pages`, the `<name>:<scope>` ledger key; reading either |

## Files rows merged: `driver-pg-*-sql.ts`

| File | Owns |
|---|---|
| `driver-pg-jobs-sql.ts` | every statement returning a whole `x_jobs` row, `JOB_ROW_COLUMNS`; via `driver-pg-sql.ts` |
| `driver-pg-operator-sql.ts` / `driver-pg-settle-sql.ts` | their statements; `SQL_ACK` / `SQL_NACK` (no counter since 31.13.0) and `SQL_COUNTER_FLUSH`, the batch `counter-batch.ts` writes |
| `driver-pg-outbox-sql.ts` | the `x_outbox` statements |
| `driver-pg-demand-sql.ts` | `QUEUE_DEMAND_ROWS` and `SQL_QUEUE_DEMAND`; the scaler fixture's `SQL_SCALER_DEMAND` reads the same predicate |
