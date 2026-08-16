# 06 — Concurrency, lifecycle and failure recovery

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0–3 + `cli` (5).

Every item marked **proven** was reproduced with a temporary Bun test or `bun -e` script, since
deleted. Baseline before the sweep: `bun test packages/realtime` 511 pass, `packages/jobs` 373 pass,
`packages/cache` 293 pass — **no existing test covers any finding below**.

## Critical

- `packages/jobs/src/worker.ts:289` — a rejecting `fleetSlots.acquire()` leaves the in-process
  limiter lease acquired at `:272` unreleased, so each lease-store error permanently burns one
  concurrency slot until the worker reaches zero and stops claiming **forever**. The only release is
  `lease.release()`, reached in the `fleetSlots === false` branch (`:290`) and in the run chain's
  `.finally` (`:313-316`); `await fleetSlots.acquire(job)` sits between them and is a Postgres write
  (`x_job_leases`), so a failover, pool timeout or `57P01` rejects there, propagates out of
  `claimRound`, and is caught only by `schedule()`'s log at `:373-378`. Proven: a concurrency-4
  worker whose lease store rejects four times reports `limiter.inFlight() === 4` and then claims
  nothing — after the store recovers, `worker.tick()` returns 0 executions, forever. The whole
  `worker` role dies silently from a transient database error; the only symptom is four
  `jobs.worker.tick-failed` lines and a climbing `queue_depth`. Fix: acquire the fleet slot inside a
  `try` whose `catch` releases before rethrowing, or take it before `limiter.tryAcquire`. Pattern one
  file over: `packages/jobs/src/worker-fleet-slots.ts:83` — `release` never lets bookkeeping fail the
  caller.

- `packages/realtime/src/live-query.ts:212,218,227` — `subscribe()` attaches **after**
  `authorize`/`prepare`/`#read`, so a socket closing (or a `{op:'drop'}` frame arriving) during that
  read strands a subscription nothing can reach. `sync-node.ts:161`'s `teardown` →
  `registry.unsubscribeSocket(socket.id)` walks the book the in-flight subscribe has not written to
  yet; `#attach` registers it afterwards. Proven by both entrances: `subscription('sock-1','sid-1')`
  is defined and `subscriberCount(qid) === 1` with `socket.closed === false`. Leaked per occurrence:
  one `QueryEntry` — its matcher, its shared row window, its retained change buffer — pinned for the
  process lifetime (`unsubscribe` deletes only when `subscribers.size` hits 0, `:242`), plus a
  per-subscriber policy-gate pass on every change fanned out to a socket that is gone. This is the
  restart-storm shape exactly: 50k clients reconnecting, each `subscribe` doing a DB read, any client
  giving up mid-read leaks an entry. Fix: capture a generation / `socket.closed` before the awaits
  and unwind instead of attaching; `live-query.ts:183-185` already shows the shape.

- `packages/realtime/src/offline-queue.ts:142` — `drain()` marks a mutation `acked` when the
  fire-and-forget `send()` returns, so a mutation the server never received is never resent and never
  leaves the queue. `client.ts:349` passes `async (mutation) => { this.#send(mutateFrame(mutation)) }`
  and `#send` (`client.ts:443`) is `this.#socket?.send(...)` — a browser `WebSocket.send` on a
  CLOSING/CLOSED socket discards silently. Proven: after socket death + reconnect + `drain()`,
  `queue.pending()` is empty, zero `mutate` frames go out, and the entry sits at `{status:'acked'}`
  forever (only `ack(key)` at `:166` removes it, and that ack can never arrive). Every in-flight
  mutation is lost on a socket death — the exact event the durable queue exists for. Fix: leave it
  `inflight`; only a server `ack`/`fail` moves it out. Pattern:
  `packages/jobs/src/driver-memory.ts:169`.

- `packages/realtime/src/client.ts:163` — `onOpen` replays `#registrations` (live queries) but never
  `#topics`, so every `client.subscribe(topic, handler)` is **dead after the first reconnect**.
  Server-side topic membership lives on `SyncSocket.topics` and `hello` carries none. Proven: after
  `close(1006)` → reconnect, the new socket's frames are exactly `['hello']` while the handler is
  still in `#topics`. Every channel message and every presence frame is lost for the life of the
  client, with `useConnection().online === true` and no error. `client-reconnect.test.ts:74-75` pins
  the live-query path only. Fix: walk `#topics` in `onOpen` emitting the frame `subscribe()` builds
  at `client.ts:265-271`.

- `packages/query/src/cache.ts:115-117` and `packages/cache/src/tiers.ts:211-215` — the read-through
  fill has no version/epoch fence, so an invalidation landing while the source read is in flight is
  overwritten by pre-write rows. T0 miss → `run()`; T1 a mutator commits and `invalidateTags` drops a
  key that is not there yet (no-op); T2 `run()` resolves with rows read before the write; T3
  `tier.set(...)` writes them for the full TTL. Proven in both files, and against `stack.drop(key)`
  as well as `invalidateTags`. The write is invisible to every reader for `ttlMs` and the
  invalidation report says `errors: []`. Fix: sample a per-tag epoch before `run()`, re-check before
  `tier.set`, skip on change — the identity-check shape already at `packages/query/src/cache.ts:81`
  and `packages/cache/src/single-flight.ts:35`.

- `packages/query/src/read-cache.ts:112` — `invalidateQueryTags` has **zero production callers**, and
  `setReadCache(tierReadCache(shared))` runs only when `REDIS_URL` is set
  (`packages/cli/src/dev-cache.ts:107-112`), so on every non-Redis deployment an action's
  `cache.invalidates` never busts a `cache:` query. Proven: after `invalidateTags` reports success
  over `['request-memo','lru']`, a fresh `Ctx` is served pre-write rows without executing the source.
  Wiring, not a race — but it produces a failure indistinguishable from the two above and would mask
  them in any repro, so it lands first.

## High

- `packages/core/src/lifecycle.ts:225-237` — `runPhase` awaits every hook with **no deadline**; only
  `waitForIdle` (`:249-250`) is bounded, so `configureLifecycle({ deadlineMs })` does not bound a
  drain at all and the file header's "under one deadline" is false. No hook reads
  `reason.deadlineAt`: `jobs/worker.ts:448` awaits the full teardown including every in-flight job and
  `driver.close()`; `jobs/scheduler.ts:319` awaits its round; `realtime/sync-listen.ts:33` awaits
  `node.drain()`'s 5s grace; `http/server.ts:176,184` await `server.stop()`. Proven: `deadlineMs: 100`
  with one 5s `accept`-phase hook → `drain()` resolves after 5053ms, state pinned at `draining`.
  A `worker` pod holding a 10-minute job ignores its drain budget and is SIGKILLed mid-job by the
  kubelet — turning at-least-once into the every-deploy duplicate the worker header says draining
  exists to prevent. Fix: race each phase against `reason.deadlineAt`, log `X_SHUTDOWN_TIMEOUT`
  naming the hook that overran. Timeout pattern: `packages/db/src/client.ts:207-238` (`reserveWithin`).

- `packages/http/src/server.ts:198-216` with `packages/core/src/lifecycle.ts:240-241,111-113` —
  `drainPromise` is memoized for the process lifetime and `markReady()` only promotes from
  `starting`, so **a second server started after any drain is born permanently draining**: it binds a
  socket, answers `X_DRAINING` 503 to every request, and its `stop()` never closes the socket. Proven:
  server 1 start → 200 → `stop()`; server 2 binds port 28411 with `lifecycleState() === 'stopped'`,
  `/ping` → 503, `/readyz` → 503; `second.stop()` returns the settled drain promise so the
  `close`-phase hook (`server.ts:184-192`) never runs and the port stays bound. `packages/http/CLAUDE.md`
  explicitly supports this start→stop→start shape, and it is what any sequential test suite or
  embedder does. Fix: make the drain a cycle — clear `drainPromise` and return `state` to `starting`
  when the last registration goes, or let `markReady()` reset from `stopped`. `resetLifecycle()`
  (`:326`) is currently the only way back and is documented test-only.

- `packages/realtime/src/query-window.ts:117` — `startRead` clears `entry.stale` **before** issuing
  the read, so a snapshot that rejects leaves the window unmarked and the gap repair is never
  retried. Path: a sequence gap → `registry.invalidate()` marks entries stale and subscribers
  desynced (`live-query.ts:127-133`) → next change → `refillWindowInLane` (`live-query.ts:334`) →
  `startRead` sets `stale = false` → `definition.snapshot()` rejects (pool exhausted during the same
  incident that caused the gap). Proven: `reads` stays at 2 across the next delivery while
  `entry.rows` still holds the pre-gap window and `entry.lsn` advances over it. `#resnapshot` then
  re-snapshots the desynced subscribers out of that divergent window and clears their marks —
  permanent silent divergence, the one thing `stale` exists to prevent. `fillWindow`'s forced path
  (`:84-93`) has the same hole. Fix: re-mark `entry.stale = true` in a `.catch` before rethrowing.

- `packages/realtime/src/sync-node.ts:348-372` — inbound frames dispatch as
  `void (async () => routeFrame(...))()` with no per-socket lane, so one client's frames are
  processed concurrently and out of order. `routeFrame` awaits policy, snapshot reads and `onMutate`;
  two `mutate` frames from one socket can be applied to the database in the reverse of the order sent
  (`sync-frames.ts:104` calls `onMutate` straight through; the client's `seq` is carried but orders
  nothing server-side). This is also the mechanism behind the two subscribe races in
  [`02-tier23-bugs.md`](02-tier23-bugs.md). Fix: one FIFO lane per `socket.id` — the mechanism exists
  one layer down at `packages/realtime/src/window-lock.ts:9` (`WindowLock`, "FIFO, one task at a time").

- `packages/realtime/src/client.ts:151` — a dial that throws out of an app-called `connect()` on a
  live client leaves `connected === true`, `#socket === null` and no timer armed: permanently offline
  while reporting online, every subsequent mutation marked delivered and dropped. Proven. `close()`
  (`:206-216`) gets this right; `connect()`'s failure path does none of it.

- `packages/realtime/src/client.ts:346` — `drain()` has no in-flight lane and `pending()` includes
  `inflight`, so two overlapping drains send the same mutation twice on one connection. Proven: two
  concurrent `mutate()` calls put **four** `mutate` frames on the socket, same keys, same seqs; the
  node applies no dedupe. Fix: one shared drain promise, the `worker.ts:418` joined-teardown shape.

- `packages/realtime/src/client-frames.ts:76` — an `ack` carrying an error marks the queue entry
  `failed` but never rolls back the optimistic write or drops its rebase entry: a denied mutation
  stays on screen forever and leaks a `RebaseLog` entry and a journal row. Cross-lane: the node
  builds that error ack with `ref: ws.data.socketId` (`sync-node.ts:366`) instead of the mutation
  key, so `queue.fail(frame.ref)` looks up a key that cannot exist — the path is inert end to end
  today. Both halves must land together.

- `packages/realtime/src/client.ts:90` — the client has **no heartbeat**, so a subscribed client is
  swept out of every presence room within one TTL (`presence.ts:69`, 30s; swept on that interval by
  `sync-node.ts:246`) and a half-open socket is never detected. `realtime.heartbeatMs`
  (`packages/core/src/config.ts:84,205`) has no reader anywhere in the repo.

- `packages/realtime/src/client-frames.ts:50` — the registration cursor advances only on `snapshot`
  frames; `patch.lsn` is ignored, so `cursor.at` never moves and `shouldResnapshot`'s
  `now - cursor.at > maxLagMs` (`cursor.ts:122`, 5 min) is true for every client connected longer
  than five minutes. The delta-resume path the `RingChangeBuffer` exists for is dead precisely during
  the deploy storm it was built for.

- `packages/cache/src/invalidate.ts:212` — the fan-out walks tiers in **read** order, so a read racing
  the bust promotes a stale value out of a not-yet-cleared far tier back into the already-cleared
  near tiers. Proven: after `invalidateTags` returns `errors: []` over
  `['request-memo','lru','redis']`, `lru.get('post:1')` is `'STALE'`. Fix: invalidate farthest-first
  (`.reverse()` in `fanOut` and in `CacheStack.drop`, `tiers.ts:223`).

- `packages/query/src/cache.ts:112,116` — the read tier's `get`/`set` are unguarded, so a Redis
  refusal fails a business read the database could have answered — the failure
  `packages/cache/CLAUDE.md` forbids and that the 2026-08-12 audit fixed one tier up. Fix:
  `bestEffort` (`packages/cache/src/tier-failures.ts:61`).

- `packages/cache/src/redis.ts:243-267` and `:225-230` — two ordering defects on the shared tier: the
  invalidation script drops the tag bucket atomically with `SMEMBERS`, so a failure in the
  client-side `DEL` batch orphans the surviving members permanently (a retry returns `keys: []`); and
  `set` writes the value key before the tag `SADD`s, so a bust landing between them finds an empty
  bucket and the just-written value survives its own invalidation. Both proven against a fake
  `RedisLike`.

## Medium

- `packages/db/src/pglite.ts:206` — `run()` skips the turn queue whenever `currentTx() !== undefined`,
  and the `AsyncLocalStorage` store survives into any promise chain started inside a transaction
  body, so a straggler from a finished transaction jumps the single-session queue and lands **inside
  somebody else's open transaction**. Proven: statement order `BEGIN, select 'inside tx', COMMIT,
  BEGIN, select 'straggler', select 'inside tx 2', COMMIT`. The pooled driver handles this shape —
  `client.ts:370-379`'s `held` fence sends a late statement back to the pool for its own connection.
  Precondition is app code forgetting an `await` inside `withTransaction`. Fix: fence on the
  transaction's liveness, not on the ALS store's presence — mark `TxState` closed on exit and fall
  through to `turns.run` for a closed one.

- `packages/realtime/src/sync-listen.ts:33` — the sync node's shutdown hook is registered with **no
  `phase`**, so it lands in `close` while `http/server.ts:176`, `jobs/worker.ts:448` and
  `jobs/scheduler.ts:319` all register theirs in `accept`. Between SIGTERM and the close phase the
  node's `ready` flag is still true, so `fetch` (`sync-node.ts:285`) keeps accepting new websocket
  upgrades onto a process that is going away — exactly what the accept phase exists to prevent. Its
  5s grace then runs inside the unbounded `close` phase. Fix: split into an `accept`-phase hook that
  flips `ready` false plus the existing drain in `close`.

- `packages/jobs/src/outbox.ts:369-373` — `relay.stop()` clears the interval but does not await the
  tick in flight, and `startRoles.stop()` (`packages/cli/src/dev-roles.ts:355`) calls it
  synchronously before `runtime.stop()` closes the database. A SIGTERM between `driver.enqueue` and
  `markPublished` leaves the row re-published next boot (collapsed by the idempotency key) or hits a
  closed pool. Absorbed by at-least-once, but it is the one loop in the package whose `stop()` does
  not join its in-flight work — `worker.ts:411` and `scheduler.ts:297` both do.

- `packages/cache/src/single-flight.ts:22-25` — the flight is keyed on `key` alone, so a joiner's
  `tags`/`ttlMs` are silently discarded and its entry is unreachable by the tag it declared. Proven.

- `packages/cache/src/redis.ts:197-208` — `GET` and `PTTL` are two independent commands, so a key
  expiring between them returns a value with `PTTL: -2` → `expiresAt: undefined` → promoted into the
  LRU on the **caller's full TTL**. CONFIDENCE: high on mechanism, window small, not reproduced live.

- `packages/query/src/read-cache.ts:79-82` — the catch absorbs only `CacheTooLargeError` and nothing
  validates `cache.ttlMs` at declaration, so `ttlMs: Infinity` makes every read of that query fail
  permanently with `X_CACHE_TTL_INVALID`.

- `packages/cache/src/tiers.ts:152` — `createCacheStack`, the package's only read-through path and
  the only caller of `createSingleFlight`/`isExpired`/the promotion logic, has **zero callers in this
  repo**; the memo and LRU tiers registered at `dev-cache.ts:104-105` are never read or written, and
  contribute permanently empty rows to every `InvalidationReport`.

- `packages/realtime/src/client.ts:163,151,317` and `hooks.ts:33` — `onOpen` is the one socket handler
  with no `if (this.#socket !== socket) return` identity guard (CONFIDENCE: low on browser
  reachability, fully reachable through the injected `ClientSocket` seam); `connect()` does not clear
  `#connected` when replacing a live socket, producing a duplicate `subscribe` for one sid that the
  node refuses with `X_SUBSCRIPTION_ID_TAKEN`, and an out-of-order frame before `hello`; a collapsed
  idempotency key applies the optimistic twin twice; `setLiveClient` discards the unsubscribe
  `onQueueChange` returns, so listeners accumulate.

- `packages/realtime/src/client.ts:178` and `client-frames.ts:77` — two floating promises with no
  rejection handler bottoming out in `QueueStore.save()` (OPFS/IndexedDB, allowed to reject). Correct
  local pattern: `sync-node.ts:125-135`'s `detach`.

## Low

- `packages/jobs/src/worker.ts:206` — `AbortSignal.any([base.signal, heartbeat.signal])` composes onto
  the caller's signal per job; harmless with the framework's own per-job `createContext()`
  (`dev-roles.ts:286`), but an app supplying a process-lifetime signal accumulates one composite per
  job run.
- `packages/jobs/src/backfill-pass.ts:213` — the step runner's `claimed` name Set (`steps.ts:184`)
  grows one entry per batch and is never bounded; a 5M-row sweep at `batch: 250` holds 20,000 strings.
  The bound's rationale (`MAX_TRACE_NAMES`) covers only the array.
- `packages/core/src/lifecycle.ts:207-223` — `waitForIdle` computes its budget from
  `clock.monotonic()` but sleeps on a real `setTimeout`, so a fake clock and the drain deadline
  disagree. Test-surface only.
- `packages/realtime/src/client.ts:443,220` and `offline-queue.ts:90` — `#send` ignores backpressure
  and `ClientSocket` does not expose `bufferedAmount` (the server half gets this right at
  `socket.ts:100-112`); a `useLive` opened while offline reports `loading` rather than `offline`;
  `find` matches terminally-`failed` entries, so an explicit idempotency key can never be retried
  after a denial.
- Bare `Date.now()` in a package that injects a clock everywhere: `packages/query/src/cache.ts:116`,
  `read-cache.ts:62`, `packages/cache/src/semantic.ts:119`, `memo.ts:59`, `tiers.ts:205`,
  `redis.ts:226-230`. Also `remember` bypasses `assertTtl`; memo entries carry no expiry and no
  bound; `lookup` runs outside the flight so N concurrent misses each do a full tier walk; the write
  path issues `1 + 2×tags` sequentially awaited round trips.
- `packages/action/src/invoke.ts:251` — `bustAfterCommit` has no transaction awareness; an app
  wrapping `invoke` in `db.transaction(...)` busts before commit. No tracked app does this.
  CONFIDENCE: low.

## The bench claim is not what CLAUDE.md says it is

`scripts/bench/restart-bench-client.ts:99-108` with `packages/realtime/src/socket.ts:100-112` and
`channel.ts:158` — **the 50k restart harness cannot see a lost patch, by construction.**
`handleMessage` records `lastSeenSeq = row.seq` unconditionally (with a comment explicitly declining
an ordering check) and sets `patchAfterOpenAt ??= Date.now()`; the orchestrator reads only
`patchAfterOpenAt` (`restart-bench.ts:318`) and `lastSeenSeq` is consumed by nothing. There is no
expected-vs-received accounting, so the committed **"49,981 received a channel patch inside the
window"** is a *reachability* measurement — reconnect + resubscribe + one delivery — and says nothing
about consistency.

The gap matters because the path it exercises has no repair: `SyncSocket.send` drops a frame and
returns `false` under backpressure, `SocketRegistry.deliver` (`socket.ts:214-220`) ignores that
return, and `ChannelHub`'s bridge (`channel.ts:158`) ignores it too. For a **channel topic** there is
no cursor, no `desynced` mark and no re-snapshot, so a dropped channel frame is silently and
unrecoverably lost, with no counter and no log. The live-query path does repair via `markDesynced`;
channels do not. The harness also subscribes only to a channel topic, never to a live query, so no
part of the snapshot/cursor/gap machinery is under test.

Fix, in order: count dropped channel frames on the socket and log them; give the bench client a
per-connection seq-gap counter and report it beside the timing; re-run; then restate the claim in
`CLAUDE.md` and `README.md` in terms of what the harness actually measures. Until the counter exists,
the number is a reconnect result, not a consistency result — say so.

## Tests

- Failing-first per Critical/High. Key ones: a rejecting lease store does not burn limiter slots
  (`bun test packages/jobs/src/worker.test.ts`); a socket closing mid-`subscribe` leaves no entry in
  the book; `drain()` leaves an unsent mutation `inflight`; a reconnect re-subscribes topics;
  an invalidation during an in-flight fill is not overwritten; `deadlineMs` actually bounds a slow
  hook; start → stop → start answers 200 on the second server; a rejecting snapshot leaves
  `entry.stale === true`; two frames from one socket apply in order.
- `packages/realtime/src/client-reconnect.test.ts` currently pins the live-query path only — extend
  it to topics, which is what would have caught the dead-`subscribe` bug.
- Bench: a seq-gap counter asserted zero in a small in-process run, so the harness can fail.

## Done when

- Every Critical and High fixed with a failing-first test.
- `configureLifecycle({ deadlineMs })` bounds a real drain, proven by a test with a slow hook.
- Channel-frame drops are counted and logged; the bench reports gaps; the 50k claim in `CLAUDE.md`
  and `README.md` is restated to match what is measured.
- `bun run verify` green.
