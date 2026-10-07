# @ultimat3/realtime — agent notes

Tier 3 package. Channels, live queries, local-first sync. One protocol for all three.

## Boundary

| May import | Must not |
|---|---|
| `@ultimat3/core`, `@ultimat3/query`, `@ultimat3/entity` (`/record` only, server-side) | anything tier 4+ (`render`, `pwa`, `mcp`, `ui`, `cli`) |
| `@ultimat3/policy` **only via** `@ultimat3/query`'s `guardQuery` for a decision (`policyCapability` / `policyPermissions` are display reads) | a second authz path of any kind |
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
- **`error-titles.ts` holds the codes, titles and `registerErrorCodes()`**; `errors.ts` the server
  refusals, `page-errors.ts` the browser ones, `realtime-error.ts` the base class (TDZ),
  `replication-errors.ts` Postgres. All re-exported from `./errors`. A hook's chunk never loads
  `errors.ts` (`page-errors-bundle.test.ts`).
- **`sideEffects` is `["./src/error-titles.ts"]`**, imported bare by the barrel (`refusalError` and
  `page-errors.ts` title by code); never `false` or absent.
- **Every `@ultimat3/realtime/<subpath>` written in shipped source must be a key of `exports`**,
  comments included — `fix-specifier.test.ts`.
- A browser file imports core from `@ultimat3/core/page` (`packages/core/src/page-bundle.test.ts`).

## Numbers and ceilings

- **Every numeric option is refused when it is not FINITE** — `@ultimat3/core`'s `finiteOption()`.
  `bun run finite-bounds` cannot see an option with no `??` default: read the option interfaces. `SyncGrant.expiresAt` is app DATA, deliberately unscreened.
- **A ceiling is refused where the object is BUILT**, never in a per-connection callback:
  `socketCeilings()` (`sync-node-bounds.ts`) runs once in `syncNode`; `SyncSocket` keeps its own
  screen because it is exported. `AcceptBudget`, `SyncSocket` and `SocketRegistry` throw
  `X_INVARIANT` at construction on `NaN`/`±Infinity`.
- **A ceiling per resource, and the wire's are not options** (table in `README.md`): the accept
  budget bounds the rate, `maxConnections` the count, `socket.frameBudget` an open socket (checked
  at the top of `routeFrame` **before `touch()`**), and `FRAME_LIMITS` in `decode` everything a
  client sizes (narrowable, never widenable). `list()` takes a required `max`. `input` is walked
  ITERATIVELY.
- **A `SubscriptionLimitError` names the knob**: every throw site passes `knob` explicitly;
  `channel.test.ts` asserts the hub's two against the option names.
- **Retained memory is bounded by BYTES** (`RingChangeBuffer`: patch count bounds replay, bytes
  bound memory). `forget(qid)` runs when the last subscriber goes and from `#dropIfUnheld`.
- **The ring floor is one rule (`change-buffer.ts`, `Ring`)**: only a read that LANDED floors it
  (`fillWindow().landed`), a forced one exclusively; a position-less read is marked with the
  node's origin and answers that cursor alone below its first patch; a stale entry serves cold
  starts only.
- **Every question a hot path asks is indexed**: `SubscriptionBook` keeps `#bySocket` and a
  per-tenant count; `SocketRegistry` keeps `#byTopic`, changed only by `joinTopic`/`leaveTopic`.
  `reauthorize` calls `book.retenant(socket)`.
- **A cap is a RESERVATION taken before the first await**: `SubscriptionBook.reserve(socket, sid)`
  decides the sid claim, `maxPerSocket`, `maxPerTenant` and `maxPerActor` in one synchronous step;
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
  one subscriber; a failed `reauthorize` keeps the subscription, a DENIED one is refused under its sid
  (`refuseSubscription`) — as is one whose org moved, and a failed re-seat. Failures count as
  `gateFailures` via `onGateFailed`, never `onRowDenied`.
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
  sequence — or a NEW producer after a known one — stales every window; `refillWindowInLane` replaces it.
- **A bulk write stales only its entity's readers**: windows + channel topics, `invalidate(entity)`
  on both from `onBulk`. **A stale window's re-read re-snapshots EVERY subscriber**, before the lsn
  guard, even on a non-match (`live-replicator-bulk`, `live-fanout` tests).
- **A WINDOW is per TENANT**: its id is `windowId(queryHash(name, input), tenant)` (`live-tenant.ts`;
  tenant = the subscriber's `actor.orgId`). This package owns no hash. The read runs `readFor`
  (`live-definition.ts`): the node's ctx, a service actor carrying ONLY that org — never the
  subscriber. A cursor naming another window is a cold start; `reauthorize` re-seats a
  subscription whose actor changed org (`live-tenancy.test.ts`; `docs/history/realtime.md`).
- **A `sid` is CLIENT data: a subscription is keyed by `(socket, sid)`**
  (`subscription-book.ts` is the only spelling). Reusing a sid the same socket holds is
  `X_SUBSCRIPTION_ID_TAKEN`.
- **`rateLimit:` is spent once per NEW subscription** (`live-spend.ts`).
- Truth is the server. A client is never the merge authority.

## The node, the bus and presence

- `sync` is stateless: no sticky sessions, nothing on a socket survives a restart.
- **`selectTransport(env, realtime)` is the one place `realtime.transport` + env become a bus** (KV
  bucket and presence TTL come back with it). The config decides, the env supplies: `'nats'` refuses
  (`X_CONFIG_INVALID`) when the `urlEnv` variable is unset; `'memory'` refuses a set one.
- **`nats` is imported only by `nats-lib-client.ts`**; its reconnect re-subscribes. Only when it
  GIVES UP (`onClosed`) does `NatsTransport` re-dial on backoff and re-bind kept subscriptions
  (`nats-subscriptions.ts`); callers meanwhile are refused. KV semantics: `nats-jetstream`/`nats-kv`.
- **Nothing leaves `NatsTransport` uncoded** — `#translating` wraps `publish`/`subscribe` refusals
  as `X_TRANSPORT_UNAVAILABLE`. `#ensure` reuses a mid-reconnect client on purpose;
  `Transport.onReconnect(listener)` (required) announces each recovery.
- **A bucket name is checked before interpolation** (`assertBucket`, `X_TRANSPORT_PROTOCOL`); a
  presence key or member id is base64url-encoded (`encodeToken`), never validated.
- Presence lives in `transport.shared`. The sync node is `PresenceRegistry`'s only caller:
  subscribing to a topic IS joining, repeating the frame is the heartbeat, dropping or closing is the
  leave. Expiry is silent, so the node sweeps on an interval, and **one node per topic sweeps** (lowest
  id in the lease's keyed set; the lease carries the roster followers record). `roster()` caps a frame at `maxMembers` (256) with `total`;
  `list()` is never capped. `total` is set on `sync` frames only.
- **A socket the node evicts ITSELF goes through `evict(socket, code, reason)`** (the full
  `teardown`), never `sockets.remove`. **`drain()` waits for the presence leaves it started** —
  `evictInChunks` (`drain-evictions.ts`, `DRAIN_EVICT_CHUNK`, `allSettled`).
- **The idle sweep is armed by `start()`** (`idleTimeoutMs / 4`, floored at 1 s, `.unref()`), on
  `Clock.monotonic()`. `SocketRegistry.idle()` is a query; the node evicts.
- **`drain()` and `stop()` both call one idempotent `release()`**; `drain()` releases after the
  sockets are gone and before `hub.close()`.
- **Refusing and draining are two phases**: `stopAccepting()` is `accept`, `drain()` + `stop()`
  `close`; `listenSyncNode` unregisters both on `stop()`.
- **A hub that closed opens nothing**: `close()` sets `#closed` before the walk; `#open` closes a
  late subscription and RAISES `X_TRANSPORT_UNAVAILABLE`. `#release` takes the reserved bridge, never
  a name.
- **An upgrade from another origin is `403 X_SOCKET_ORIGIN_REFUSED`** before `authenticate`
  (`sync-origin.ts`): `allowedOrigins`, when declared, is the WHOLE list; undeclared, the
  `Host`-derived origin (and its `https` spelling when reached over plain http). The refusal names
  the asker and the list. `x dev` keeps the reached-on origin (`admitReachedOrigin`) and adds
  its web role's beside a declared list; a container adds nothing. `AcceptBudget` is reserved before
  `authenticate`, `refund()`ed on every exit that takes no socket.
- **A socket's actor comes from `syncNode({ authenticate })` only**, run before
  `server.upgrade`. `null` = 401 `X_SOCKET_UNAUTHENTICATED`; a throw = 503
  `X_SOCKET_AUTH_UNAVAILABLE`. Absent = anonymous, and `start()` warns. The actor lives only in the
  `GrantBook`.
- **The grant is recorded BEFORE `server.upgrade`** (Bun runs `open` synchronously inside it) and
  released on every path that never opens — `onUngranted` is REQUIRED on `UpgradeDeps`, and a
  `server.upgrade` that THROWS releases too. `sync-node-auth.test.ts`'s harness opens inside
  `upgrade()`, as Bun does.
- **A grant expires; a socket does not**: expired grants are re-decided on an interval
  (`hub.onActorChange`, `registry.reauthorize`). No `refresh` = close `1008`; one that raises retries.
- **Every `socket.send` reads its answer**: a dropped subscribe reply marks it desynced; a dropped
  roster logs `sync.presence_roster_dropped`; `drain()` returns `DrainedSocket[]` (`notified`).
- **Inbound frames run in a lane, never the socket**: `subscribe` is `sub:<sid>` or `topic:<name>`,
  everything else unlaned (`frame-lanes.ts`); a lane exists only while work is queued.
- **A dropped `records` frame is counted AND repaired**: per-node `seq`/`epoch` per channel; a refused
  frame marks the socket gapped, and the `drain` handler sends `replay-gap`
  (`channel_replay_gaps_total`). The client re-runs `catchUp`, holding frames meanwhile.
- **A channel is a DECLARATION, no primitive** (docs/history/primitive-factories.md):
  `channel(name, { params, policy, catchUp, records?, events? })`, deny by default; `policy`
  REQUIRED (`X_CHANNEL_DECLARATION_INVALID`; public: `allow('public')`). Presence: `events`.
- **A guard that FAILS on re-auth SUSPENDS the seat** (`guardFailures`): kept, silent until a pass.
  A `null` actor on a `row` channel and a tenancy refusal are DENIALS.
- **A seat is decided for the actor ON the socket when the guard resolves** (`#settle`); a denied
  re-ask on a suspended seat is refused and latched. The latch is capped at `maxTopicsPerSocket`.
- **A missed change reopens every records topic** (`ChannelHub.invalidate()`, beside both
  `registry.invalidate()` sites; `sync-bus-handlers.test.ts`).
- **A `recordPublisher` change (`source: 'publisher'`) feeds channels ONLY** — no commit position:
  never `registry.deliver`, its gap stales no window; a new publisher is no gap. One producer KIND
  per table per node (`ProducerKinds`, `X_REALTIME_PRODUCER_CONFLICT`); the x dev bridge skips a
  claimed table (`isPublishedTable`). `ChangeEvent.table` is the relation on every producer.
- **An error never renders a credential**: `parsePgUrl`/`parseNatsUrl` name the variable.

## Replication

- Exactly one `replicator` per DB, by a session-level advisory lock. **`start()` and
  `PostgresAdvisoryLock.tryAcquire` are MEMOISED**; `stop()`/`release()` await the in-flight one. A start
  that FAILS hands the lock back; `running` is set once the feed pumps.
- **The pump has one way out, `#die`**: failure recorded, timer stopped, connection closed, then
  `onEnd(reason)`. `start()` awaits the previous pump. **`stop()` releases everything first.**
- **A stream that ENDS is restarted**: feed then lock ABANDONED (synchronous, never asked);
  `stop()` bounds both goodbyes by `STOP_DEADLINE_MS`; redial on `retryDelayMs` (injected
  `schedule`) from `lastLsn` until `stop()`. The delay resets only when a change is PUBLISHED. A
  rejected `publish` is one such end, and so is a LOST lock (`AdvisoryLock.onLost`), mid-dial
  included. `running` = pumping AND no refused change owed; `onChange` is fenced per run and
  REFUSES, never drops.
- **A row crosses the bus through its entity's columns** (`replicator-row.ts`): `parseEnvelope`
  revives by `entityForTable` + `$parse`, bytes as base64 — by declared kind, never by shape.
- **Cleartext/md5 auth is answered only under `sslmode` `require`, `verify-*` or `disable`**.
- **The replicator ensures its publication** (`pg-publication.ts`): `CREATE … FOR TABLE` every
  entity table, or `ALTER … ADD TABLE` the missing; never a DROP, never `FOR ALL TABLES`.
- **TLS is libpq's `sslmode`** (`pg-tls.ts`): only `verify-*` verify; the runtime never rejects,
  `judgeHandshake` decides; the raw socket is DEAF after `upgradeTLS`.
- **Every session pins `datestyle=ISO`, `intervalstyle=postgres`, `extra_float_digits=3`, `TimeZone=UTC`**.
- A change lsn is `<16 hex commit position><8 hex row position>`; never order by one half, a wall
  time or a counter.
- Slot, publication and entity names match `[a-z_][a-z0-9_]*` before interpolation — a security
  boundary (`pg-identifier.ts`). A SQLSTATE is data: `FIXES` is read with `Object.hasOwn`.
- **A live row equals a repository row**: `pg-entity-row.ts` decodes by `@ultimat3/entity`'s
  `decodeRow` / `entityForTable`.

## The page

- **One record store per PAGE (`record-store.ts`)**, keyed `type:key` with the SERVER's key
  (`live-record-type.ts`); the browser never derives one. SYNCED truth plus an OVERLAY of pending
  optimistic writes, REPLAYED over synced truth whenever it moves. Installed as core's `RecordSink` on
  `pageClient().store`.
- **Page state lives on `globalThis[Symbol.for('ultimate.realtime')]` (`page-store.ts`)**, never module
  scope — every island is its own bundle (`page-client.test.ts` builds two islands). Never
  `instanceof` across copies.
- **The signal factory is per BUNDLE**: `installRealtime({ signal, sync })` (`reactivity.ts`). No
  install and a DOM is `X_REALTIME_UNINSTALLED`; no DOM is a server render — hooks answer
  `pending`/online and create no page state. `useRecord` and `useQuery` return `AsyncState` accessors.
- **The page runtime (`page-runtime.ts`) is installed once per page, never in an island**;
  hooks call `installedPage(hook).services`. One socket per page (`page-socket.ts`);
  `browser-socket.ts` holds the only `new WebSocket`. `rescope` clears the store, redials.
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
- **A frame names the write that produced it**: `records.write`, `patch.writes` (a live patch
  one, a resume each it replays, off `RowPatch.write` in the ring) — `writeDigest(key)`, from a
  REQUIRED `ChangeEvent.write: string | null`. `RecordStore.push` digests each overlay key first
  (`record-names.ts`); `client-channels.ts` / `live-rows.ts` settle in the frame's own batch. A
  non-digest is a protocol error, dropped on the bus. Partly confirmed rows go to
  `OverlayEntry.confirmed`. `write-echo.test.ts`, `live-write-echo.test.ts`.
- `local(tx, input)` is pure and CONVERGENT: no I/O, no `Date.now()`, no `Math.random()`.
- **One conflict vocabulary**: `ConflictPolicy` from `@ultimat3/core`, resolved by core's
  `resolveConflict(overlayRow, serverRow)` in `RecordStore.settle`. A server delete is not a conflict.
- Anything a component reads is a getter or accessor. `MutatorLike.local` uses method syntax.
  `useQuery`'s input is read once, at call time.
- **`useRecords(type, selection)` holds the TYPE** (`retainType`): `ready` at once, recomputed per
  change to that type, no row of it evicted while held; the last type hold evicts what it spared.
- Every subscription handle is `Disposable`; `[Symbol.dispose]` IS the release. Type claims go in
  `type-pins.ts`.
- **The outbox**: only `pending` is sendable; `drain()` is one chained pass at a time; `#epoch` is
  bumped before the requeue scan, read every pass. `#persist` hands SNAPSHOTS by KEY; one tab drains
  (`navigator.locks`), resetting a stored `inflight`. A `rescope` abandons the queue and bumps the
  epoch synchronously; `enqueue` decides WHOSE queue before its first await
  (`X_OFFLINE_QUEUE_ABANDONED`); `useMutation` fences its POST on its scope epoch. A refused disk is
  warned `X_LOCAL_STORE_UNAVAILABLE`, never rejecting `ready`. An entry leaves disk at its ack.

## The client connection

- **The client owns its reconnect**: a closed socket arms ONE timer through the injected `Scheduler`
  that calls `connect()`. `onClose` nulls `#socket`, schedules only when nothing is armed (a
  `reconnect` frame's slot wins), and speaks only for its own socket; `close()` cancels. A dial that
  throws in the timer is reported through `onError` (default `console.error`) and arms the next.
- **`connect()` closes the socket it replaces**; `onOpen`, `onMessage` and `onClose` all carry the
  identity guard.
- **A refusal `ack` is revived as a branded `UltimateError`** (`refusalError`, `client-frames.ts`).
- **A reconnect replays registrations AND topics** — one `hello`, one `subscribe` per registration
  (with its cursor) and per topic.
- **The client beats** (`DEFAULT_HEARTBEAT_MS` 10 s = default ttl / 3, pinned by
  `client-heartbeat.test.ts`; `0` disables): a `hello` plus one subscribe per topic. Two silent
  windows close with `4000`. **The node names the beat: `hello.heartbeatMs`** — `Heartbeat.follow`
  per socket; the engine reaps ports on the longer of its own and the node's.
- **There is ONE `backoffDelay`, `@ultimat3/core`'s, counted from 1** — `policyDelay()` maps a
  `BackoffPolicy` onto it; `bun run flight-copies` refuses a second curve.

## Rules for code here

- Never a bare `Error`. Never `any`. Never `Date.now()` — take a `Clock` (`monotonic()` for durations).

## The page boot

- **The disk boot is ONE page script (`boot.ts`, `./boot`)**, served at `/_x/page-boot/<hash>.js`
  on a document with the scope tag and a realtime island; it installs the runtime, wipes every other
  principal's stored scope (read at the wipe), then restores. `booted` reads its promise off
  `Symbol.for('ultimate.page-boot')`. No boot: islands load its chunk.
- **An island never carries the outbox**: `boot.ts` builds it; `useMutation`, `useOutbox`, the page socket
  read it through `outbox-slot.ts` after `page.booted`. No boot ⇒ a refused write is rejected, not queued.

## Map

`index.ts` / `server.ts` are the two barrels. Server side: `sync-node.ts` (+ `sync-auth`,
`sync-frames`, `sync-upgrade`, `sync-listen`, `drain-evictions`), `channel.ts`, `presence.ts`,
`socket.ts`, `live-query.ts` (+ `live-definition`, `live-refusal`, `live-tenant`, `live-resume`, `query-window`, `live-fanout`, `window-lock`,
`subscriber-gate`, `policy-gate` — the only authz seam — and `matcher-bridge`), `replicator.ts` (+ `replicator-envelope`) /
`live-replicator.ts`, the Postgres client (`pg-*.ts`, `pgoutput.ts`), the bus (`nats-*.ts`,
`transport-env.ts`, `fanout.ts`). Client side: `client*.ts`, `socket-engine.ts` / `socket-host.ts` /
`sync-worker.ts`, `record-*.ts`, `page-*.ts`, `boot.ts`, `offline-queue.ts`, `use-*.ts`,
`reactivity.ts`. Shared: `sync-protocol.ts` (the wire), `cursor.ts`, `change-buffer.ts`,
`thundering-herd.ts`, `live-contract.ts`, `json.ts` (no hash), `type-pins.ts`.

## Commands

```
bun test packages/realtime/src   # from the REPO ROOT
bun run typecheck
```

`bunfig.toml`'s preload installs `@ultimat3/testing`'s matchers; Bun reads it from the cwd.

Changing a frame shape means a fixture in `sync-protocol.test.ts` (the round-trip test fails
without one) and bumping `PROTOCOL_VERSION` **when an old frame becomes unreadable in either
direction**. `decode` is a whitelist: an additive optional field, or removing a field read through
`list()`, is free; removing a field read through `str()`/`num()` (which throw) is a bump.

Why each rule is shaped so, and browser bytes per hook (re-measure before quoting):
[`docs/history/realtime.md`](../../docs/history/realtime.md).
