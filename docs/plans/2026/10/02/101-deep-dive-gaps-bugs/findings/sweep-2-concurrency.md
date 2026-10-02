# Sweep 2 — concurrency, lifecycle, failure recovery (areas sweep 1 left unexamined)
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only audit at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: realtime server side, storage, auth sessions and limiters, render ISR, flags, ai, pwa,
> admin, scraping, entity repositories. No docker service started — every live-only claim is marked.
> CONFIRMED (probe) = deterministic probe ran. CONFIRMED (reading) = both sides read. PLAUSIBLE = argued.

## Critical

| # | Where | Interleaving | Damage | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/cli/src/runtime-render.ts:432`, `serve-web.ts:150`, `cmd-dev.ts:244` | no boot calls `IsrController.attach()`. A page with `revalidate: { tags }` renders v1; an action runs `invalidateTags`; `packages/cache/src/invalidate.ts:242` does `await revalidator?.(path)` — `undefined`; the next request is `hit`, v1 | a tag-only ISR page (`ttlMs null`) serves pre-write HTML for the life of the process, on every pod; `report.isr` still lists it as revalidated. The reference app's `/pricing`, `/blog`, `/blog/[slug]` are tag-only. `registerRevalidator` has no caller outside `packages/render/src/render-isr.ts:292` | CONFIRMED (probe): un-attached → `hit` / v1; attached → `stale` then v2 | call `isr.attach()` where the controller is built; push its detach onto the boot's stop list | `packages/cli/src/runtime-render.test.ts` (unit: render, `invalidateTags`, expect `x-ultimate-isr: stale`); one e2e in `packages/cli/e2e/` |
| 2 | `packages/realtime/src/pg-replication.ts:252` (`#die`), `packages/cli/src/role-replicator.ts:95` | the walsender ends the copy (restart, failover, `wal_sender_timeout`, three failed confirms); `#die` records `stats().failure` and closes; `createReplicator`'s `running` stays `true`; `startReplicator` called `start()` once; nothing reads `stats().failure` | every live query and channel in the fleet freezes on its last snapshot until the replicator pod is restarted; WAL accumulates behind the slot. Comments at `pg-replication.ts:57,259,414` say `/readyz` reads the failure — it does not (`runtime-services.ts:393` registers only the transport check). The advisory-lock session dies too, but `PgAdvisoryLock.#connection` is non-null, so `tryAcquire()` answers `true` from memory | CONFIRMED (reading) | `registerReadinessCheck('replicator', …)` over the feed's `failure`; a supervised restart through `stop()` then `start()` — `retryDelayMs` (`replicator.ts:227`) exists with no caller | `packages/cli/src/role-replicator.test.ts` (unit, over `pg-replication-fixture.ts`); `packages/realtime/src/pg-replication.live.test.ts` (live) |

## High

| # | Where | Interleaving | Damage | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 3 | `packages/realtime/src/change-buffer.ts:98` | client C on node A holds p1=v1 at lsn 120; A drains. lsn 130 updates p1 — node B has no entry, appends nothing. D cold-subscribes on B (snapshot 130). lsn 160 inserts p2 — B's ring is `[160]`, `evictedThrough: null`. C reconnects to B with cursor 120; `since()` returns `[160]`, `in-window` | C gets one insert patch and keeps p1=v1 forever on a healthy socket. The rolling-deploy shape | CONFIRMED (probe) | a ring carries a floor at birth: set `evictedThrough` from the window's lsn at the entry's first read (the `reborn` branch on the same line) | `packages/realtime/src/change-buffer.test.ts`; a two-registry case in `live-query.test.ts` (unit) |
| 4 | `packages/auth/src/auth.ts:285-305` | N logins for one account each pass `assertAllowed` (a read); all run the KDF; all call `recordFailure` | 40 concurrent guesses against `maxAttempts: 3` all reached verification — the only bound is the KDF gate. `postgresAuthLimiter` has the same shape | CONFIRMED (probe) | count the attempt before the await, refund on success — `SubscriptionBook.reserve` (`packages/realtime/src/live-query.ts:167`) | `packages/auth/src/auth-lockout.test.ts` (unit); `rate-limit-postgres.live.test.ts` (live) |
| 5 | `packages/ai/src/budget.ts:169-205`, `gateway.ts:126` | the reservation turnstile is per root ledger; each `gateway.scope()` builds a new root. Two requests of one org both read `spent` 0, both pass, both debit | `budget: { org: 1500 }`, 1,000-token calls: 8 concurrent scoped calls all reached the provider; serially 1 does. `budget.ts:137` claims this closed in-process. Across processes `BudgetStore` (`spent` + `add`) cannot express an atomic reserve | CONFIRMED (probe) | debit first and check the returned total — `SQL_RATE_LIMIT_TAKE` (`packages/http/src/rate-limit-postgres.ts:72`); or key the turnstile on `(store, key)` | `packages/ai/src/gateway-budget.test.ts` (unit) |

## Medium

| # | Where | Interleaving | Damage | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 6 | `packages/realtime/src/sync-node.ts:194-212`, `nats-transport.ts:199`, `replicator.ts:304-312` | the node's NATS connection drops; seq 42 is missed; the library reconnects and tells nobody. Also: a replicator restart mints a new `producer`, and `SeqGapDetector` never treats a first message as a gap | with no later write, windows and cursors stay behind indefinitely; new subscribers join the stale window | CONFIRMED (reading) | surface `onReconnect` to the node → `registry.invalidate()`; a new producer after a known one is a gap | `packages/realtime/src/sync-node.test.ts` over `nats-fake.ts` (unit); `nats-transport.live.test.ts` (live) |
| 7 | `packages/realtime/src/presence.ts:187-222` | the sweep leader's node dies; non-leaders skipped every sweep, so the new leader's `#seen` holds only its own members | the dead node's members are never announced as left; clients show them until their own reconnect | CONFIRMED (probe): 120 s after the kill, leaves announced `[]` | a non-leader still records the live ids it sees, or the new leader diffs against the last roster shipped | `packages/realtime/src/presence.test.ts` (unit); `presence.live.test.ts` (live) |
| 8 | `packages/admin/src/action-gate.ts:282`, `batch-matching.ts:71` | `action.handle` commits; `audit.append` throws in the same `try`; the `catch` appends `failed` and rethrows. For `matching` the append is outside the `try` | the log says a committed action failed; the operator re-runs a non-idempotent action. The set-based write commits with no entry at all | CONFIRMED (reading) | handler and append inside `audit.atomic`, as `auditedWrite` (`packages/admin/src/crud-outcome.ts:91`) | `packages/admin/src/action-gate.test.ts` (unit); `audit-pg.contract.test.ts` (contract) |
| 9 | `packages/render/src/render-isr.ts:187-229` | one `render()` never settles; `pending[path]` is pinned | a missed path hangs every later request; a stale path serves stale forever. Only a restart clears it | CONFIRMED (reading) | `createSingleFlight` with `deadlineMs` (as `packages/auth/src/jwks.ts`) | `packages/render/src/render-isr.test.ts` (unit, injected scheduler) |
| 10 | `packages/realtime/src/sync-node.ts:231`, `sync-auth.ts:103-118` | the re-auth sweep is a non-reentrant interval over a serial loop; after a deploy every grant expires in one 30 s window; a pass that outlasts 30 s overlaps the next. A socket closing during `refresh()` has its grant written back by `grants.set` | duplicate auth-store reads; each duplicate re-snapshots every subscription on the socket; a closed socket's grant is refreshed forever | mechanism CONFIRMED (reading); PLAUSIBLE at scale | memoise the pass (as `replicator.ts:189`); guard `grants.get(id) === grant` after the await | `packages/realtime/src/sync-node-auth.test.ts` (unit, frozen clock) |
| 11 | `packages/admin/src/batch.ts:287-303` | a queued batch enqueues chunks one by one under a random `batchId`; chunk 3's enqueue throws; the operator retries under a new `batchId` | the rows of chunks 0–2 run twice | CONFIRMED (reading) | derive `batchId` from the request, or enqueue all chunks in one transaction through the outbox | `packages/admin/src/batch.test.ts` (unit); a `.job.` case for the dedupe |
| 12 | `packages/realtime/src/page-outbox.ts:89-158` | A's outbox holds m1, m2; a pass starts; a client-router navigation rescopes to B; the pass still holds A's list and sends m2 | m2 goes out with B's cookies — A's queued write executes as B. Header promises "never sent as the next" | PLAUSIBLE, medium | capture the scope at pass start, re-check before each `send` — `OfflineQueue.#epoch` (`offline-queue.ts:309`) | `packages/realtime/src/page-outbox.test.ts` (unit, gated `send`) |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/storage/src/driver-local.ts:293-294` | `put` writes bytes then sidecar, in place — a concurrent `get` or a crash pairs new bytes with the old `contentType` / `etag` (non-atomic `put` is an open row of the 2026-09-28 audit). Fix: temp file + rename, sidecar first | reading |
| `packages/storage/src/attachment.ts:146-147` | `promoteAttachment` copies then deletes; a rolled-back row write leaves the object outside `pending/`, unseen by `sweepOrphans`; the retry fails `X_STORAGE_NOT_FOUND` | reading |
| `packages/scraping/src/auth.ts` (`burnSession`, `markRefused`), `scrape-run.ts:254-258` | session store writes are blind — two runs on one session key can burn or tombstone the session the other persisted | PLAUSIBLE |
| `packages/scraping/src/scrape-run.ts:215` | an unguarded `persistSession` failure fails an attempt that already logged in; the retry logs in again | reading |
| `packages/realtime/src/channel.ts:265` | `#join` seats a socket after `await this.#open()` with no closed check — a bridge pinned with zero members, a presence member for a closed socket. Fix: `#attachUnlessGone` (`live-query.ts:429`) | CONFIRMED (probe, slow bridge); low on reachability |
| `packages/ai/src/gateway.ts:173-175` | an unguarded `cache.set` after `record` turns a paid call into a thrown one; the retry is billed twice. No single-flight on a miss | reading |
| `packages/pwa/src/service-worker.ts:280-281` | the install fill stores whatever pod answers; mid-rollout an old pod's document lands in the new build's precache. Fix: compare the build header (`seenBuild`, `:389`) | PLAUSIBLE, low |
| `packages/entity/src/pg-driver.ts:309-313` | a JS-only invariant is asserted after the `update` was sent; outside `withTransaction` the violating row is committed (acknowledged in a comment) | reading |
| `packages/admin/src/crud.ts:259-305` | `adminUpdate` diffs against an earlier `before` with no version check — a posted full form overwrites a concurrent edit; the audit `before` can be wrong | reading |

## Not a bug (do not re-open)

- Verification token double-consume — one `UPDATE … WHERE consumed_at IS NULL` (`builtin-adapter.ts:326-335`).
- Session reads on a lagging replica — the `auth` stage runs before `withReplicaReads` (`packages/http/src/stages.ts:121,212`).
- Session revocation across replicas — re-read per request, no cache; sync sockets follow within one grant TTL + one sweep.
- `SQL_RATE_LIMIT_TAKE` — one upsert.
- Auth limiter count under concurrent failures — `pg_advisory_xact_lock`; the defect is the check before the KDF (row 4).
- State transitions — one conditional `updateWhere`.
- Row observer — reports through `afterCommit`.
- ISR bust during a regeneration — `sampleFence` + `registerPath` before render.
- LSN confirmed before fan-out — `#confirmed` moves only at `commit`.
- Two replicas on one slot — session advisory lock (but see row 2 on the dead lock session).
- Snapshot lsn sampled before the read; live subscribe onto a closed socket; late older read vs read generations.
- Offline queue, two tabs — `navigator.locks` + reload-under-lock.
- SharedWorker tab close / reap; browser or rented-CDP leak on abort; abandoned AI stream reservation.
- Flags — no cache, pure evaluation. Static memo stampede — harmless.

## Still not examined

- `realtime`: `socket.ts` backpressure, `sync-upgrade`, `pg-connection` / `pg-socket` close paths, `nats-lib-client`, `nats-jetstream`, the channel log / replay ring.
- `storage/driver-s3` (no multipart; `put` buffers), `accept`, `grant`; `auth` memory limiter, `mfa` replay guard; `http` memory rate-limit store.
- `ai`: `llm`, `llm-cache`, `tools`, provider wire, `rag` / `vector`. `scraping`: `watchdog`, `cdp-target`, `http`, `event-prompt`.
- `entity`: `memory-repo`, `jit-preload`, `seed`, `batch`. `admin`: the MCP path, jobs dashboard actions. `render`: navigation cache.
- Unverifiable without a live service: a real walsender, NATS reconnect, JetStream KV TTL ordering, Postgres row locks under READ COMMITTED, any browser behaviour. Rows 2, 6, 10 and the pwa row rest on reading plus fakes.
