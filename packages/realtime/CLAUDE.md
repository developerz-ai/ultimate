# @ultimat3/realtime — agent notes

Tier 3 package. Channels, live queries, local-first sync. One protocol for all three.

## Boundary

| May import | Must not |
|---|---|
| `@ultimat3/core`, `@ultimat3/query`, `@ultimat3/entity` (`/record` only, server-side) | anything tier 4+ (`render`, `pwa`, `mcp`, `ui`, `cli`) |
| `@ultimat3/policy` **only via** `@ultimat3/query`'s `guard` | a second authz path of any kind |
| — | `solid-js` (each island bundle installs its own signal factory: `installRealtime`) |
| `nats` (the one external dependency, pinned exact) — from `nats-lib-client.ts` and no other file | `nats` from anywhere else. Every other file is written against the port in `nats-client.ts` |

## Entries and bundling

- **Two entries; a name lives in exactly ONE.** `.` is the client half (`use-*`, `page-*`,
  `reactivity`, `record-*`, `client*`, `browser-socket`, `live-rows`, `apply-patches`,
  `offline-queue`, `sync-protocol`, `json`, `cursor`, `errors`, the client half of
  `thundering-herd`). `./server` (`server.ts`) is everything touching `nats`, Postgres, the sync node,
  the hub, the registry or the fanout (`nats` requires `stream/web`, which a browser build cannot
  link). `packages/cli/src/realtime-browser-barrel.test.ts` bundles a `useLive`-only entry;
  `barrel-split.test.ts` refuses a name exported from both. `./boot` and `./sync-worker` are the page
  boot and the SharedWorker entry.
- **`errors.ts` is the code table plus the client-reachable refusals**; `realtime-error.ts` holds
  the base class alone (an `extends` must not read it in a TDZ) and `replication-errors.ts` the
  Postgres ones. Every name is still exported from `./errors`. A browser path loads `page-errors.ts`,
  never the table (`page-errors-bundle.test.ts`).
- **`sideEffects` is the ARRAY `["./src/errors.ts"]`**, never `false` (drops `registerErrorCodes()`)
  and never absent. `bun run side-effects` is the check.
- **Every `@ultimat3/realtime/<subpath>` written in shipped source must be a key of `exports`**,
  comments included — `fix-specifier.test.ts`.
- **`@ultimat3/realtime/server` needs its own `paths` entry in `tsconfig.base.json`** (the wildcard
  maps it to a directory that does not exist; `scripts/**` reports `TS2307` without it).
- A browser file imports core from `@ultimat3/core/page` (`packages/core/src/page-bundle.test.ts`,
  `packages/query/src/client-bundle.test.ts`).

## Numbers and ceilings

- **Every numeric option is refused when it is not FINITE** — `@ultimat3/core`'s `finiteOption()`.
  `bun run finite-bounds` reads zero for this package, but it cannot see an option with no `??`
  default or where a screen runs, so audit by reading the option interfaces
  (`SubscriptionBook`'s `maxPerTenant` and `openNatsClient`'s `maxReconnectAttempts` were the two it
  missed). `SyncGrant.expiresAt` is app DATA, not an option, and is deliberately unscreened.
- **A ceiling is refused where the object is BUILT**, never in a per-connection callback:
  `socketCeilings()` (`sync-node-bounds.ts`) runs once in `createSyncNode`; `SyncSocket` keeps its own
  screen because it is exported. `AcceptBudget`, `SyncSocket` and `SocketRegistry` throw
  `X_INVARIANT` at construction on `NaN`/`±Infinity`.
- **A ceiling per resource, and the wire's are not options** (table in `README.md`): the accept
  budget bounds the rate, `maxConnections` the count, `socket.frameBudget` an open socket (checked
  at the top of `routeFrame` **before `touch()`**), and `FRAME_LIMITS` in `decode` everything a
  client sizes (narrowable, never widenable). `list()` takes a required `max`. `input` is walked
  ITERATIVELY.
- **Every `SyncSocket` ceiling is reachable from `createSyncNode`**, forwarded as
  `...(x === undefined ? {} : { x })`.
- **A `SubscriptionLimitError` names the knob**: every throw site passes `knob` explicitly;
  `channel.test.ts` asserts the hub's two against the option names.
- **Retained memory is bounded by BYTES**: `RingChangeBuffer` keeps the patch count as a replay
  bound and byte budgets as the memory bound. `forget(qid)` runs when the last subscriber goes and
  from `#dropIfUnheld` after a failed cold subscribe (only if the entry is still in the table, unheld
  and has no read in flight).
- **Every question a hot path asks is indexed**: `SubscriptionBook` keeps `#bySocket` and a
  per-tenant count; `SocketRegistry` keeps `#byTopic`, changed only by `joinTopic`/`leaveTopic`.
  `reauthorize` calls `book.retenant(socket)`.
- **A cap is a RESERVATION taken before the first await**: `SubscriptionBook.reserve(socket, sid)`
  decides the sid claim, `maxPerSocket` and `maxPerTenant` in one synchronous step;
  `ChannelHub.subscribe` does the same for its caps. Released in a `finally`, idempotently.
- **Readiness AND the connection cap are functions on `UpgradeDeps`**, re-asked after
  `authenticate` (app code with an await) and right before `server.upgrade`. The recheck sheds with
  the same 503 + `retry-after-ms` and spends no second `tryAccept()`.

## Live queries

- Policy is evaluated **once per subscriber**, never once per query (`live-query.test.ts`, and
  `live-definition.test.ts` for a real `query({ live: true })`). Every policy call in `live-query.ts`
  takes a `Subscriber`.
- **A name nothing registered is `X_LIVE_QUERY_UNKNOWN`**, fix `x queries list --json`. The
  registry is never enumerated over the wire.
- **One build per `(query, input)`**: `target.live()` returns the descriptor and runs the read
  (`LiveQuery.execute`), never memoised.
- `liveQueryDefinition` caches per query id the compiled source, shape, matcher and shared window —
  never a decision. The shared half is built with `enforce: false` on purpose; `authorize` runs per socket.
- **The row policy sees the WHOLE row from the shared window.** A patch whose row the window does not
  hold is WITHHELD (not denied, not a failure). A delta resume onto an unread entry fills it first
  (`entry.lsn === ''`).
- **A denial is a decision; everything else is a failure.** `visibleWithPolicy` matches
  `QueryDeniedError` and rethrows the rest; `subscriber-gate.ts` and `reauthorize` ask
  `isPolicyDenial(error)`. A failed snapshot raises out of `subscribe`; a failed delivery desyncs that
  one subscriber; a failed `reauthorize` keeps the subscription. Failures count as `gateFailures` via
  `onGateFailed`, never `onRowDenied`.
- **One serial lane per query id (`WindowLock`) is the only thing that orders a fanout.** `deliver`
  enters every lane before awaiting any; no fanout takes a second lane; a lane that fails desyncs its
  own subscribers; lanes chain on a settled shadow of each task.
- **Two reads of one entry are ordered by a READ GENERATION**, never by an lsn (`QueryEntry.lsn` may
  be `''`): `entry.generation` / `entry.applied` is an identity check. The lsn guard stays for the
  other question — a read that resolved behind a change the fanout already folded.
- **The definition's read is once per entry**: a cold subscriber joins the in-flight read (a share,
  cleared on settle), and the result lands in the lane and never backwards.
- **The shared read carries a deadline and frees the SLOT**: `startRead` races it against
  `DEFAULT_READ_DEADLINE_MS` (30 s; `new LiveQueryRegistry({ readDeadlineMs, schedule })`), rejects
  joined callers with `X_TIMEOUT` (never an empty window), and puts `stale` back. No "off" spelling;
  a non-positive or non-finite value takes the default (`query-window.test.ts`).
- The retained change window stores **pre-policy** patches; resume re-filters them per subscriber,
  outside the lane, against the live window.
- **`desynced` is a mark with a reader**: the next delivery serves a fresh snapshot out of the shared
  window and only then clears it. **`result.refill` is checked BEFORE the mark** — a guessed window
  never clears a mark (`live-fanout.test.ts`).
- **A change the window already holds is refused** (`change.lsn <= entry.lsn`, counted as
  `staleChanges`). **A gap is detected**: the replicator stamps `producer` + `seq`; a skipped
  sequence marks every window stale and every subscriber desynced; `refillWindowInLane` replaces it.
- **A qid is `@ultimat3/query`'s `queryHash(name, input)`**; this package owns no hash
  (`live-contract.test.ts`). The canonical form is core's and injective (`-0` is wire-reachable).
- **A `sid` is CLIENT data: a subscription is keyed by `(socket, sid)`**
  (`subscription-book.ts` is the only spelling). Reusing a sid the same socket holds is
  `X_SUBSCRIPTION_ID_TAKEN`.
- Truth is the server. A client is never the merge authority.

## The node, the bus and presence

- `sync` is stateless: no sticky sessions, nothing on a socket survives a restart.
- **`selectTransport(env, realtime)` is the one place `realtime.transport` + env become a bus**; the
  KV bucket and presence TTL come back with it. The config decides, the env supplies (22.0.0):
  `'nats'` dials the variable `urlEnv` names and refuses (`X_CONFIG_INVALID`) when unset; `'memory'`
  refuses a set `NATS_URL` (or the named variable).
- **`nats` is imported only by `nats-lib-client.ts`**; reconnect and re-subscription are the
  library's job — `NatsTransport` must never grow subscription bookkeeping. What stays above the
  port: the herd jitter (`reconnectDelayHandler`) and the KV semantics presence needs
  (`nats-jetstream.ts`, `nats-kv.ts`). `nats-fake.ts` is a bus with server semantics.
- **Nothing leaves `NatsTransport` uncoded** — `#translating` wraps the port's synchronous
  `publish`/`subscribe` refusals as `X_TRANSPORT_UNAVAILABLE`; an `UltimateError` passes through.
  `transport-parity.test.ts` asserts both transports, and that the wrap still delivers. `#ensure`
  reuses a mid-reconnect client on purpose.
- **A bucket name is checked before interpolation** (`assertBucket`, `X_TRANSPORT_PROTOCOL`); a
  presence key or member id is base64url-encoded (`encodeToken`), never validated.
- Presence lives in `transport.shared`. The sync node is `PresenceRegistry`'s only caller:
  subscribing to a topic IS joining, repeating the frame is the heartbeat, dropping or closing is the
  leave. Expiry is silent, so the node sweeps on an interval, and **one node per topic sweeps** (lowest
  id in the lease key's keyed set). `roster()` caps a frame at `maxMembers` (256) with `total`;
  `list()` is never capped. `total` is set on `sync` frames only.
- **A socket the node evicts ITSELF goes through `evict(socket, code, reason)`** (the full
  `teardown`), never `sockets.remove`. **`drain()` waits for the presence leaves it started** —
  `evictInChunks` (`drain-evictions.ts`, `DRAIN_EVICT_CHUNK`, `allSettled`).
- **The idle sweep is armed by `start()`** (a quarter of `idleTimeoutMs`, floored at 1 s, `.unref()`)
  and measures on `Clock.monotonic()` (`lastSeenMonotonicMs`). `SocketRegistry.idle()` is a query;
  the node evicts.
- **`drain()` and `stop()` both call one idempotent `release()`**; `drain()` releases after the
  sockets are gone and before `hub.close()`.
- **Refusing new sockets and draining are two phases**: `stopAccepting()` is `accept`, `drain()` +
  `stop()` are `close`. `listenSyncNode` unregisters both on `stop()`.
- **A hub that closed opens nothing**: `close()` sets `#closed` before the walk; `#open` closes a
  late subscription and RAISES `X_TRANSPORT_UNAVAILABLE`. `#release` takes the reserved bridge, never
  a name.
- **A socket's actor comes from `createSyncNode({ authenticate })` only**, run before
  `server.upgrade`. `null` = 401 `X_SOCKET_UNAUTHENTICATED`; a throw = 503
  `X_SOCKET_AUTH_UNAVAILABLE`. Absent = anonymous, and `start()` warns. The actor lives only in the
  `GrantBook`.
- **The grant is recorded BEFORE `server.upgrade`** (Bun runs `open` synchronously inside it) and
  released on every path that never opens — `onUngranted` is REQUIRED on `UpgradeDeps`, and a
  `server.upgrade` that THROWS releases too. `sync-node-auth.test.ts`'s harness opens inside
  `upgrade()`, as Bun does.
- **A grant expires; a socket does not**: expired grants are re-decided on an interval through
  `hub.onActorChange` and `registry.reauthorize`. No `refresh` = close with `1008`; a `refresh` that
  raises keeps the socket and retries.
- **Every `socket.send` reads its answer**: a dropped subscribe reply marks the subscription desynced;
  a dropped presence roster is logged (`sync.presence_roster_dropped`); `drain()` returns
  `DrainedSocket[]` with `notified` and logs `sync.drain_frames_dropped`.
- **Inbound frames run in a lane, never the socket**: `subscribe` is `sub:<sid>` or `topic:<name>`,
  everything else unlaned (`frame-lanes.ts`); a lane exists only while work is queued.
- **Bun's native pub/sub is deleted**; `SocketRegistry.deliver` is the one fanout path.
  `WsLike.subscribe`/`unsubscribe` stay declared for structural implementers.
- **A dropped `records` frame is counted AND repaired**: per-node `seq`/`epoch` per channel; a refused
  frame marks the socket gapped, and the websocket `drain` handler sends `replay-gap`
  (`channel_replay_gaps_total` beside `channel_frames_dropped_total`). The client re-runs the
  channel's `catchUp`, holding frames meanwhile.
- **A channel is a DECLARATION**: `channel(name, { params, policy, catchUp, records?, events? })`.
  Deny by default, and `policy` is REQUIRED (`X_CHANNEL_DECLARATION_INVALID`; a public channel says
  `policy: allow('public')`). Presence rides `events: true` channels.
- **A guard that FAILS keeps the topic on re-auth** (`guardFailures`, `channel.guard_failed`); the
  initial subscribe still refuses.
- **A channel patch id carries the node** (`nodeId`, default a per-hub `uuid()`).
- **An error never renders a credential**: `parsePgUrl` names `DATABASE_URL`, never the URL.

## Replication

- Exactly one `replicator` per DB, by a session-level advisory lock. **`start()` and
  `PgAdvisoryLock.tryAcquire` are MEMOISED** (guard and promise published synchronously, cleared on
  settle); `stop()`/`release()` await the in-flight one. A start that FAILS hands the lock back, and
  `running` is set only once the feed pumps.
- **The pump has one way out, `#die`**, which records the failure, stops the confirm timer, closes and
  nulls the connection. `start()` awaits the previous pump before it dials. **`stop()` releases
  everything before it reports anything.**
- **`REPLICA IDENTITY FULL` is checked at preflight, warned, and counted — never thrown** — ahead of
  `pg_create_logical_replication_slot`. `ReplicationStreamStats.partialBefore` reads
  `PgRelation.replicaIdentity`, never the tuple.
- **Every session pins `datestyle=ISO`, `intervalstyle=postgres`, `extra_float_digits=3`** in the
  startup packet (`pg-connection.ts`, pinned by `pg-connection.test.ts`), byte for byte what
  Postgres' own walreceiver sends.
- A change lsn is `<16 hex commit position><8 hex row position>`; never order by either half alone,
  never depend on wall time or a process counter.
- Slot, publication and entity names match `[a-z_][a-z0-9_]*` before interpolation — a security
  boundary. A SQLSTATE is data: `pg-wire.ts`'s `FIXES` is read with `Object.hasOwn`.
- **A live row equals a repository row**: `pg-entity-row.ts` decodes through `@ultimat3/entity`'s
  own `decodeRow` / `entityForTable`, so money (three physical columns), scale and every other kind
  fold exactly as `postgresRepo` folds them.
- A write's name rides the WAL: `pg-replication.ts` reads it off the transaction's opening
  `pg_logical_emit_message` (prefix `WRITE_ORIGIN_WAL_PREFIX`; `START_REPLICATION` asks
  `messages 'true'`).

## The page

- **One record store per PAGE (`record-store.ts`)**, keyed `type:key` with the SERVER's key
  (`live-record-type.ts`); the browser never derives one. SYNCED truth plus an OVERLAY of pending
  optimistic writes, REPLAYED over synced truth whenever it moves. Installed as core's `RecordSink` on
  `pageClient().store`.
- **Page state lives on `globalThis[Symbol.for('ultimate.realtime')]` (`page-store.ts`)**, never module
  scope — every island is its own bundle (`page-client.test.ts` builds the package twice). Never
  `instanceof` across copies.
- **The signal factory is per BUNDLE**: `installRealtime({ signal, sync })` (`reactivity.ts`). No
  install and a DOM is `X_REALTIME_UNINSTALLED`; no DOM is a server render — hooks answer
  `pending`/online and create no page state. `useRecord` and `useQuery` return `AsyncState` accessors.
- **One socket per page, built by the first live hook (`page-socket.ts`)**; `browser-socket.ts`
  holds the framework's only `new WebSocket`. `hasPageSocket()` lives in `page-store.ts`. A principal
  change (`rescope`) clears the store and redials.
- **One socket per ORIGIN and principal, in a SharedWorker**: `socket-engine.ts` holds it and talks
  to tabs over `MessagePort`s (`socket-host.ts`'s virtual socket); wants are ref-counted and frames
  routed; a port silent for `REAP_AFTER_BEATS` is reaped; each tab resubscribes from its OWN cursors.
  No `SharedWorker` → the in-page host runs the same engine over a `MessageChannel`.
- **The socket is READ-ONLY (protocol 3)**. A write is `useMutation`: the twin into the overlay, then
  `POST actionPath(name)` through core's `clientTransport` with an idempotency key; the answer's
  records are adopted inside the transport call, before `settle`. An `ack` is only a refusal.
- **`LiveClient` holds no signal** — plain reads plus `onStatus` / `onChange`; hooks wrap them.
- **An answer that did not carry a touched row keeps that row's overlay** until the server's next row
  for it, bounded by `DEFAULT_AWAIT_SERVER_MS` (10 s).
- **A `records` frame names the write that produced it** (`ChannelRecordsFrame.write =
  writeDigest(idempotencyKey)`, never the key). `RecordStore.push` digests every overlay key before
  the request leaves (`record-names.ts`); `client-channels.ts` settles inside the frame's own batch.
  A non-digest `write` is a protocol error (`wire-channel.ts`) and dropped on the bus. Rows an answer
  or echo partly confirmed go to `OverlayEntry.confirmed` and stop painting. `write-echo.test.ts`.
- `local(tx, input)` is pure and CONVERGENT: no I/O, no `Date.now()`, no `Math.random()`.
- **One conflict vocabulary**: `ConflictPolicy` from `@ultimat3/core`, resolved by core's
  `resolveConflict(overlayRow, serverRow)` in `RecordStore.settle`. A server delete is not a conflict.
- Anything a component reads is a getter or accessor. `MutatorLike.local` uses method syntax.
  `useQuery`'s input is read once, at call time.
- Every subscription handle (`LiveHandle`, the hook accessors, `Unsubscribe`) is `Disposable`, and
  `[Symbol.dispose]` is the same function as the release. Type claims go in `type-pins.ts`.
- **The outbox**: only `pending` is sendable; `drain()` is one chained pass at a time; backpressure
  over `MAX_BUFFERED_BYTES` declines rather than fails. `#epoch` is bumped before the requeue scan and
  read every pass iteration. `#persist` hands the store SNAPSHOTS by KEY (`QueueChange`); one tab
  drains at a time (`navigator.locks`, `page-outbox.ts`'s `exclusive`) and resets a stored `inflight`
  to `pending` under the lock.

## The client connection

- **The client owns its reconnect**: a closed socket arms ONE timer through the injected `Scheduler`
  that calls `connect()`. `onClose` nulls `#socket`, schedules only when nothing is armed (a
  `reconnect` frame's slot wins), and speaks only for its own socket; `close()` cancels. A dial that
  throws in the timer is reported through `onError` (default `console.error`) and arms the next.
- **`connect()` closes the socket it replaces**; `onOpen`, `onMessage` and `onClose` all carry the
  identity guard.
- **A reconnect replays registrations AND topics** — one `hello`, one `subscribe` per registration
  (with its cursor) and per topic.
- **`hello` carries NO cursors** (`HelloFrame.resume` is deleted): a cursor's qid names a window but
  not the input a decision needs.
- **The client beats** (`heartbeatMs`, default `DEFAULT_HEARTBEAT_MS` 15 s, `0` disables): a `hello`
  plus one subscribe per topic (the presence heartbeat). Two silent windows close with `4000`. The
  node's `socket.skewed` compares the build the `hello` claims against its own. The server beat is
  derived: `PresenceRegistry.heartbeatMs = max(1000, floor(ttlMs / 3))`.
- **There is ONE `backoffDelay`, `@ultimat3/core`'s, counted from 1.** `policyDelay(policy, attempt,
  rng)` (internal, not on the barrel) maps a `BackoffPolicy` onto it; a 0-based counter adds 1 at the
  call site (`client.ts`, `socket-engine.ts`, `replicator.ts`'s 0-based `retryDelayMs`).
  `client-reconnect.test.ts`, `socket-engine-reconnect.test.ts`, `nats-transport.test.ts` pin the
  first wait at the base. `drainPlan()` and `AcceptBudget` keep their own arithmetic.
  `bun run flight-copies` refuses a second curve.

## Rules for code here

- Never a bare `Error`. Never `any`. Never `Date.now()` — take a `Clock` (`monotonic()` for durations).
- **A test fixture standing in for a FOREIGN error extends `Error` on purpose** (`PoolTimeout`,
  `Denied`, `ThirdPartySdkError`): it simulates a value this package did not construct. The rule
  governs what this package **throws**, never what a test hands it.

## Browser bytes, per hook (`As of 2026-09-22`)

`bun build --target=browser --minify`, one entry importing one hook from the barrel. Re-measure
before quoting.

| Hook | Current |
|---|---|
| `useRecord` | 13,226 |
| `useMutation` | 21,725 (after the outbox left islands) |
| `useQuery` | 47,696 |
| `useChannel` | 45,585 |

- **The disk boot is ONE page script (`boot.ts`, `./boot`)**, served at `/_x/page-boot/<hash>.js`
  on a document with the scope tag and a realtime island; it wipes every other principal's stored
  scope, then restores. `booted` reads its promise off `globalThis[Symbol.for('ultimate.page-boot')]`.
- **An island never carries the outbox**: `boot.ts` builds it; `useMutation` and the page socket read
  it through `outbox-slot.ts` after `page.booted`. No boot ⇒ a refused write is rejected, not queued.

## Map

`index.ts` / `server.ts` are the two barrels. Server side: `sync-node.ts` (+ `sync-auth`,
`sync-frames`, `sync-upgrade`, `sync-listen`, `drain-evictions`), `channel.ts`, `presence.ts`,
`socket.ts`, `live-query.ts` (+ `live-definition`, `query-window`, `live-fanout`, `window-lock`,
`subscriber-gate`, `policy-gate` — the only authz seam — and `matcher-bridge`), `replicator.ts` /
`live-replicator.ts`, the Postgres client (`pg-*.ts`, `pgoutput.ts`), the bus (`nats-*.ts`,
`transport-env.ts`, `fanout.ts`). Client side: `client*.ts`, `socket-engine.ts` / `socket-host.ts` /
`sync-worker.ts`, `record-*.ts`, `page-*.ts`, `boot.ts`, `offline-queue.ts`, `use-*.ts`,
`reactivity.ts`. Shared: `sync-protocol.ts` (the wire), `cursor.ts`, `change-buffer.ts`,
`thundering-herd.ts`, `live-contract.ts`, `json.ts` (no hash), `type-pins.ts`. Each file's header
states its one job.

## Commands

```
bun test packages/realtime/src            # from the REPO ROOT, never from packages/realtime
bun run typecheck
```

`bunfig.toml`'s preload installs `@ultimat3/testing`'s matchers and Bun reads it from the cwd.

Changing a frame shape means a fixture in `sync-protocol.test.ts` (the round-trip test fails
without one) and bumping `PROTOCOL_VERSION` **when an old frame becomes unreadable in either
direction**. `decode` is a whitelist: an additive optional field, or removing a field read through
`list()`, is free; removing a field read through `str()`/`num()` (which throw) is a bump. Read the
field's line in `decode` before claiming a removal is free.

Why each rule above is shaped the way it is: [`docs/history/realtime.md`](../../docs/history/realtime.md).
