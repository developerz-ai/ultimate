# @ultimat3/realtime — agent notes

Tier 3 package. Channels, live queries, local-first sync. One protocol for all three.

## Boundary

| May import | Must not |
|---|---|
| `@ultimat3/core`, `@ultimat3/query` | anything tier 4+ (`render`, `pwa`, `mcp`, `ui`, `cli`) |
| `@ultimat3/policy` **only via** `@ultimat3/query`'s `guard` | a second authz path of any kind |
| — | `solid-js` (the client takes an injected signal factory) |
| `nats` (the one external dependency, pinned exact) — from `nats-lib-client.ts`, and no other file | `nats` from anywhere else: a second importer is the failure this row exists to prevent. Every other file is written against the port in `nats-client.ts` |

## Rules

- **Two entries, and a name lives in exactly ONE of them (2026-08-22, BREAKING).** `.` is the
  client half — `hooks`, `client*`, `identity-map`, `live-rows`, `apply-patches`, `offline-queue`,
  `rebase`, `local-store`, `sync-protocol`, `json`, `cursor`, `errors`, and the client's half of
  `thundering-herd`. `./server` (`src/server.ts`) is everything that touches `nats`, Postgres, the
  sync node, the channel hub, the live-query registry or the fanout. The reason is measured, not
  aesthetic: `nats` `require()`s `stream/web`, so one barrel carrying `openNatsClient` beside
  `useLive` failed `bun build --target=browser` with
  `Browser build cannot require() Node.js builtin: "stream/web"` — the island `wiki/Realtime.md`
  promises could not be built at all. Two build errors hold it: `packages/cli/src/realtime-browser-barrel.test.ts`
  bundles a `useLive`-only entry for the browser, and `barrel-split.test.ts` refuses a name
  exported from both (values through the namespace objects, types off the source text, because a
  type-only export leaves no runtime entry). `errors.ts` is deliberately whole on `.`: every code
  reaches the wire through `toWireError`, so a client must be able to name any of them, and the
  module is already in the client graph via `sync-protocol`.
- **`errors.ts` is the code TABLE plus the client-reachable refusals; two neighbours hold the rest,
  and every name is still exported from `./errors`** (2026-08-23, at the 500-line ceiling).
  `realtime-error.ts` holds the base class alone and `replication-errors.ts` the four Postgres ones
  — the only codes no browser can reach. The base needs its own module rather than a re-export:
  `extends` runs at module evaluation and imports hoist above it, so a `replication-errors` that
  imported the base back out of `errors.ts` would read it in its temporal dead zone. Neither
  neighbour runs anything at import, which is what keeps `sideEffects` naming `errors.ts` alone
  true — `registerErrorCodes()` stays there, unconditional, and `bun run side-effects` is the check.
- **`sideEffects` is the ARRAY `["./src/errors.ts"]`, never `false` and never absent.** Absent was
  what made the failure above unrecoverable — with no field a bundler must assume every module has
  effects, so nothing was tree-shaken and `nats` came along with `useLive`. Measured, not guessed:
  `bun run side-effects --explain --json` prints what the tree actually does at import time.
  `false` would drop `registerErrorCodes()` and every `REALTIME_ERROR_TITLES` entry with it.
  **The array alone would have fixed the build** and is not why the split exists: tree-shaking is
  a bundler's discretion, `export * from` or a namespace import defeats it, and "the client entry
  cannot reach the bus" is a contract rather than an optimisation.
- **Two entries means a specifier naming a third does not resolve, and a `fix:` is pasted.**
  `local-store.ts`'s `X_NOT_IMPLEMENTED` told the caller to import `createOpfsLocalStore` from
  `@ultimat3/realtime/browser` — a subpath `exports` has never declared — so the one instruction
  the refusal carried ended in a module-resolution failure, in the package whose own rules cite
  axiom 4. Its alternative, `persist: false` on the query, was the same defect twice: `query()`
  does not accept `persist` either. `fix-specifier.test.ts` is the build error — every
  `@ultimat3/realtime/<subpath>` written in shipped source must be a key of `exports`, comments
  included, because a comment naming a subpath that does not exist is the next fix line's source.
  It cannot see WHICH names a fix promises, so the OPFS one is pinned by name beside it.
- **`@ultimat3/realtime/server` needs its own `paths` entry in `tsconfig.base.json`**, beside
  `@ultimat3/admin/dev`'s. `@ultimat3/*` maps `realtime/server` to `packages/realtime/server/src`,
  which does not exist, and the root program has no `node_modules/@ultimat3` symlink to fall back
  through — so `scripts/**` (which the root `tsc -b` compiles) reports `TS2307` without it. The
  workspace packages resolve through their own `node_modules` and never needed it, which is what
  makes the failure look local to `scripts/`.

- Policy is evaluated **once per subscriber**, never once per query. `live-query.test.ts` proves it
  for a hand-written definition and `live-definition.test.ts` proves it for a real declared
  `query({ live: true })` — the second one matters, because a rule that only holds for test fakes
  is a rule no declaration can reach.
- **Every numeric option is refused when it is not a FINITE number, `As of 2026-08-26`.**
  `finite.ts`'s `finiteOption()` is the one refusal — `bun run finite-bounds --explain --json`
  is the count, never a number written here — and this package is pinned at **zero**. `??` guards nullish and
  `NaN` is not, so `Number(process.env.X)` on an unset variable reaches the bound intact, and
  `Math.max`/`Math.min`/`Math.floor` propagate rather than validate — `AcceptBudget` was
  `Math.max(1, options.perSecond)` and admitted every accept, because `NaN < 1` is false.
- **Every ceiling is refused when it is not a FINITE number, `As of 2026-08-26`.**
  `AcceptBudget`'s `perSecond`/`burst`, `SyncSocket`'s `maxBufferedBytes`/`maxDroppedFrames` and
  `SocketRegistry`'s `idleTimeoutMs` throw `X_INVARIANT` at construction on `NaN` and `±Infinity`.
  Every comparison against a non-finite bound is FALSE, so each guard did not loosen — it switched
  off, silently. Measured: `tryAccept()` asks `tokens < 1`, so `perSecond: NaN` admitted every
  accept, herd included, on the node path AND on the per-socket frame flood budget;
  `maxBufferedBytes: NaN` made `send()` answer TRUE with 10 MB queued, so a discarded frame was
  neither counted in `channel_frames_dropped_total` nor desync-marked — the delivery-accounting
  guarantee this file states, voidable through one option; `idleTimeoutMs: NaN` left a socket idle
  for 10,000,000 ms out of `idle()`. `??` guards only nullish and `Math.max` is a clamp, not a
  validator: `Number(process.env.X)` on an unset variable reaches the comparison intact.
- **A SQLSTATE off the wire is DATA, so `pg-wire.ts`'s `FIXES` is read with `Object.hasOwn`.**
  `FIXES['constructor']` answered the `Object` function — not nullish, so `?? GENERIC_FIX` never
  fired — and `UltimateError` then ran `singleLine(fn)`: a `TypeError` out of the constructor of
  the error that exists to explain the failure, so the caller lost `X_REPLICATION_FAILED`, its
  cause and its fix at once. This was `realtime`'s one `proto-index` pin, and the pin's stated
  reason ("keyed by a replication op this package declares") described a different read.
- **A name nothing registered is `X_LIVE_QUERY_UNKNOWN`, never `X_PROTOCOL_VERSION`.** The frame
  parsed and the version matched — one string in it names nothing — so "x build && redeploy the
  client" is the one instruction that cannot work: a rebuilt client spells the typo the same way,
  and the registry that would have shown the mismatch never gets opened. The fix line is
  `x queries list --json`. The name the client sent is echoed back; the registry is never
  enumerated over the wire, because an unauthenticated socket walking `a`…`zz` is not entitled to
  a list of every read this app declares. It is a client fault, so it never pages anyone. `fix` is
  the command and nothing else — what to do with what it prints is in `cause`, because a fix line
  is pasted into a shell and prose appended to one is a command that does not run.
- **One build per `(query, input)`, and the window reads through it.** `target.live()` produces the
  descriptor *and* runs the read (`LiveQuery.execute`) — a second subject-less `sourceFor` for the
  rows was two descriptions of one read that agreed only by luck, at twice the parse and twice the
  `sql()` per query id. Both halves must come from one build or the matcher patches a window it
  never saw: `live-definition.test.ts` proves it with a declaration whose rows carry the number of
  the build that produced them, and under the old code the subscriber was served build 2's rows.
  `execute()` runs on every call rather than memoising — a client joining an existing subscription
  sees the rows as they are now.
- What `liveQueryDefinition` caches per query id is the compiled source, the shape, the matcher and
  the shared row window. What it must never cache is a decision. It builds that shared half with
  `enforce: false` **on purpose**: a source compiled under the first subscriber's authority and
  then keyed by query id is that subscriber's entitlements becoming everyone's. `authorize` is
  still the subscribe-time decision and still runs per socket.
- Every policy call in `live-query.ts` takes a `Subscriber`. That is the enforcement: there is no
  path through the gate that reads a query id and no actor.
- **The row policy always sees the *whole* row from the shared window, never a partial patch — and
  a window that does not hold the row is not a partial one.** An update patch carries the changed
  columns plus the id, so merging it onto nothing and calling that a row hands `visible` a
  `undefined` for every column the change did not touch: fail-closed for `row.ownerId === actor.id`,
  and a leak for every `!row.private`. So a patch whose row the window does not hold is **withheld**
  — dropped, or the one `delete` frame that tells a subscriber holding it that it is gone. It is
  neither `rowsDenied` nor `gateFailures`: nothing decided anything, the window simply *is* the
  result set. The one path that could meet an empty window is a delta resume onto an entry nothing
  has read yet, and `subscribe` fills it first (`entry.lsn === ''`) rather than withholding
  everything — conditional on purpose, because re-reading per resuming subscriber is exactly the
  cost a delta resume exists to skip in a restart storm.
- **A denial is a decision; everything else is a failure, and the two never share an answer.** A
  bare `catch { return false }` in the row gate read a dead pool as "you may not see this row" —
  the rows left the screen, `live.rows_denied` counted the drop, and the outage shipped as a
  permission change. `visibleWithPolicy` matches `QueryDeniedError` (the only thing `guard` throws
  for a decision) and rethrows the rest; `subscriber-gate.ts` and `reauthorize` ask
  `isPolicyDenial(error)` instead, because `authorize` and `visible` are caller-supplied functions
  and the answer has to come off the error's code. What a failure costs is decided per surface: a
  snapshot **raises** out of `subscribe` (a short result set is indistinguishable from a correct
  one), a delivery desyncs that **one** subscriber and lets the fanout finish, and a `reauthorize`
  keeps the subscription — destroying it would report a timeout as a revoked grant, and a client
  does not resubscribe to a denial. Every failure is counted as `gateFailures` and reported through
  `onGateFailed`, never through `onRowDenied`: an alert fires on one of them.
- **One serial lane per query id, and it is the only thing that orders a fanout.** Nothing upstream
  does: `sync` fires `void registry.deliver(change)` straight off the bus subscription, so two
  changes arriving back to back both start, both write `entry.rows`/`entry.lsn`, and both await
  their way through a per-subscriber gate in between. Unordered, a subscriber is handed lsn 2 and
  then asked to fold lsn 1 on top of it, its cursor rewound to 1 — a reconnect then replays what it
  already applied, over newer state, and the row stays at the older value. `WindowLock` (`run`)
  gives each entry a FIFO lane. `deliver` *enters* every lane before awaiting any of them, and no
  fanout ever takes a second lane, so holding all of them at once cannot be a cycle — and two
  deliveries queue onto each query id in call order, which is what makes "per query id, not per
  node" true. Awaiting one entry before entering the next was two bugs in one line: one slow policy
  pass set the whole node's pace, and a lane that threw ended the loop, so every entry behind it
  missed the change with **nobody desynced** — the silent divergence `markDesynced` exists to
  prevent. A lane that fails now desyncs its own subscribers and the first failure still reaches
  the caller, but it costs one query id. The lane chains on a settled shadow of each task: one
  fanout that threw must not reject every fanout behind it.
- **Two reads of one entry are ordered by a READ GENERATION, never by an lsn.** `QueryEntry.lsn`
  is optional — a definition with no lsn provider answers `''` from every snapshot — so the
  never-backwards rule expressed purely in lsn terms read `'' >= ''` as "newer" and let the older
  of two concurrent reads land on top of the newer one's window. The interleaving: a cold
  subscriber issues P1; the change stream skips a sequence and `registry.invalidate()` marks the
  entry; a second cold subscriber forces P2, which **clears `stale` on the way in**; P2 lands with
  the post-gap rows; P1 lands last and overwrites them. `stale` is false, so `fanoutChange`'s
  repair never fires, the next change patches the pre-gap window and re-snapshots every desynced
  subscriber out of it — permanently stale on a healthy socket, which is the exact outcome `stale`
  exists to prevent. `entry.generation` is bumped in `startRead` and `entry.applied` records the
  newest read whose rows are on the window: an *identity* check, the same one `startRead` makes on
  `entry.reading` one function down and `packages/cache/src/single-flight.ts:70` makes for the same
  reason. The lsn guard stays beside it for the other question — a read that resolved behind a
  *change* the fanout already folded — because those are two orderings and neither answers the
  other.
- **The definition's read is once per entry, not once per subscriber.** A cold subscriber arriving
  while another's read is in flight joins that read — N cold subscribers on one query id being N
  reads is the shared window not existing. It is a share, not a cache: the in-flight promise is
  cleared as it settles, so a later subscriber reads current rows rather than a window that has
  been drifting since boot. The result lands **in the lane and never backwards**: a snapshot that
  resolved after a newer change was already fanned out is discarded and its caller is served from
  the newer window, because rewinding hands that subscriber rows the fanout has moved past and a
  cursor behind the change that would have corrected them.
- The retained change window stores **pre-policy** patches; resume re-filters them per subscriber.
- A resume is the one gate pass that runs **outside** the lane, and it reads the live window on
  purpose: the window can only have moved forwards, and a row whose grant was revoked in the
  meantime is one that pass must refuse rather than replay from its state at the cursor's lsn.
- Truth is the server. A client is never the merge authority.
- Presence lives in `transport.shared`, never in a node's heap — it must survive a node loss.
- The `sync` node is `PresenceRegistry`'s only caller. Subscribing to a topic **is** joining its
  presence set, repeating the frame is the heartbeat, and dropping the subscription or closing the
  socket is the leave — presence has no frame of its own in either direction, because a second way
  to say "I am here" is a client that can be subscribed and invisible at the same time.
- Expiry is silent by design, so the node sweeps on an interval: without it a member whose node
  died is never announced as gone, and the survivors render a cursor that stopped moving. It has to
  be an interval — a sweep only reports members a previous sweep saw, which is how a member that
  joined on another node becomes leavable here at all.
- **The wire is the library's, the integration is ours, and `nats-client.ts` is the line between
  them.** `nats` is imported by exactly one file — `nats-lib-client.ts` — and everything else in the
  package, the transport and the JetStream bucket and the KV presence set and every test, is written
  against that port. It is what lets the fake be an in-memory bus with *server* semantics instead of
  431 lines of forged wire bytes, and what made deleting 1,019 LOC of framing, parser, PING/PONG and
  session a swap rather than a rewrite ([`docs/idea/18-build-vs-wrap.md`](../../docs/idea/18-build-vs-wrap.md)).
  The consequence that has to be held: **reconnect and re-subscription are the library's job now.** A
  subscription outlives a dropped connection because the client re-establishes it underneath the
  caller, so `NatsTransport` must never re-grow subscription bookkeeping of its own — a map of wanted
  subjects, a dial promise, a loss counter, a rebind loop. Two things re-subscribing is a doubled
  delivery on every reconnect and a subscription the caller's `unsubscribe` no longer reaches — the
  hand-rolled client's lifecycle bugs were deleted with it rather than fixed for exactly that reason.
  What stays above the port is what the library has no opinion on: our thundering-herd jitter, handed
  over as its `reconnectDelayHandler` because spreading a restart herd is the framework's decision,
  and the KV semantics presence needs (`nats-jetstream.ts`, `nats-kv.ts`) — a per-message TTL and a
  batch direct get, which the library's own KV abstraction cannot express.
- **Nothing leaves `NatsTransport` uncoded, and `#translating` is where that is enforced — added
  2026-08.** `client.publish` and `client.subscribe` are the port's two SYNCHRONOUS calls, and the
  library refuses locally on both: a bad subject, a payload over the server's `max_payload`, a
  connection torn down between the `#ensure` and the call, a permissions violation on the subject.
  A raw `NatsError` escaped `publish()` into `ChannelHub`'s bridge, `SocketRegistry` and the
  replicator — no code, no `fix:`, nothing an operator can act on — while `InProcessTransport`
  answered `X_TRANSPORT_UNAVAILABLE` for its own one refusal. `transport-parity.test.ts` asserts
  both transports in one test, and a third case proves the wrap still DELIVERS: a translation that
  swallowed a working publish would satisfy the two refusal cases and fan out nothing. An
  `UltimateError` passes through untouched — the port raises its own for a closed client, and
  re-wrapping buries the code a caller branches on. `nats-lib-client.ts`'s header claim that every
  failure leaves *there* as an `UltimateError` is still false for those two calls; the translation
  is deliberately in ONE place, and it is the transport, because `connect` is a public injection
  seam and an app-supplied client throws whatever it likes.
- **Reusing a client whatever its state is a DECISION, not the other half of that bug.** `#ensure`
  hands back a client that is mid-reconnect on purpose: the library is re-establishing that same
  connection and its subscriptions, and a second dial alongside it doubles every delivery. What a
  caller gets from a client whose reconnect budget is spent is a publish that resolves into
  nothing — reported through `onError` by `#watch`, and visible to `/readyz` through `connected`,
  which is where a dead bus is meant to be caught.
- One place reads `NATS_URL`, and it is `selectTransport` — a boot that resolved the bus itself
  could reach a different one than the container it is standing in for. The KV bucket and the
  presence TTL come back with the transport for the same reason: they are one decision.
- `sync` is stateless: no sticky sessions, nothing on a socket survives a restart.
- **A socket the node evicts ITSELF is released through `teardown`, never through
  `sockets.remove`.** Bun's `close` callback runs `teardown`; a drain and the idle sweep have no
  callback behind them — Bun's fires a tick later and `sockets.get` misses by then — so whatever
  they do instead *is* the whole release. `drain()` inlined three of `teardown`'s five steps
  (`close`, `sockets.remove`, `grants.delete`) and skipped the two the rest of the fleet can see:
  `registry.unsubscribeSocket` and `presence.leave` per topic. What that left is a `QueryEntry`
  whose `subscribers` map never empties — matcher, shared window and `WindowLock` pinned, and
  `source.forget(qid)` never called — and, worse because it is cross-node, a presence member every
  other node renders for a full TTL. During a **rolling restart** that is every room showing each
  user twice for up to 30s, beside the same client's reconnection under a new socket id. One
  `evict(socket, code, reason)`, and every path that ends a socket without a callback takes it.
- **A `drain()` WAITS for the presence leaves it started; a `close` callback cannot** (2026-08-23).
  `teardown` returns those promises as well as `detach`ing them: Bun's `close` callback is
  synchronous, so there the detach is the whole of it — but a drain has no callback behind it and
  is the one path that can wait. It did not: `release()`, `hub.close()` and the process's exit all
  ran under N·M in-flight KV writes, so every other node rendered every drained member for a full
  TTL — the same rolling-restart double vision `evict` exists to prevent, reached the long way
  round. `evictInChunks` (`drain-evictions.ts`) evicts `DRAIN_EVICT_CHUNK` sockets, waits out what
  they started, then takes the next: one synchronous loop over 50,000 sockets opens a quarter of a
  million writes on one connection at the exact moment the fleet is already restarting.
  `allSettled`, never `all` — a leave that fails is a member left to its TTL, which is what the
  write meant when nobody waited for it at all, and it must not hold up the sockets behind it.
- **The idle sweep exists, is armed by `start()`, and its budget is an APPLICATION one.**
  `SocketRegistry.sweepIdle` had no caller for as long as it existed, so `touch()`, `idleFor` and
  the 120s default decided nothing and `idleTimeoutMs` was unreachable from `createSyncNode`. The
  only live guard was `websocket.idleTimeout: 120` handed to Bun — which Bun's own ping/pong
  renews, so a client whose frame loop is wedged answers pings and keeps its `GrantBook` entry,
  its `SubscriptionBook` entries and its `#byTopic` membership forever. It is now
  `SocketRegistry.idle()`, a **query**: this table is three of the five things a socket holds, so
  the object that can evict one is the node and not the registry. `start()` arms one `.unref()`ed
  pass every `idleSweepPeriodMs(idleTimeoutMs)` — a quarter of the budget, floored at a second,
  derived rather than configured because a second knob is a second number that can disagree with
  the one it is a fraction of — and `release()` clears it beside the presence sweep. **It measures
  on `Clock.monotonic()`**, the clock `AcceptBudget` already uses: the sweep compares a DURATION,
  and a duration read off `now().getTime()` is decided by whatever NTP last wrote — a step forward
  evicts every socket that is talking, a step backward makes `idleFor` negative and spares every
  socket that is dead, and the sweep had only just gained its first caller when both became
  reachable. The field is named `lastSeenMonotonicMs` so nobody hands it to `new Date()`;
  `openedAt` is the wall-clock one and stays that way, because a human reads it.
- **`drain()` and `stop()` both release what `start()` acquired, and releasing twice is a no-op.**
  A `drain()` is terminal on its own — it closes the hub and evicts every socket — and nothing
  obliges a `stop()` to follow it, so leaving the change subscription and the presence sweep to
  `stop()` alone is a drained node still pulling every change off the bus into a fanout with no
  sockets, and still sweeping a room it left, through a hub it already closed. One `release()`,
  called by both. `drain()` calls it after the sockets are gone and before `hub.close()`: a client
  is entitled to its patches for the whole grace window, and to get them through a hub that is
  still open.
- Exactly one `replicator` per DB, enforced by a session-level advisory lock.
- **The replication pump has one way out, and it closes what it held.** Both exits — a decode error
  and `nextCopyData()` returning `undefined`, which is the walsender ending the copy — run `#die`:
  record `stats().failure`, stop the confirm timer, close the connection and null it. Each one left
  behind is a dead replicator claiming to be a live one. A `null` failure answers `/readyz` ready
  for a loop reading no WAL; a live `#running` makes the next `start()` a silent no-op; a retained
  timer keeps telling the walsender a dead stream is keeping up; a retained `#connection` is a
  socket the next `start()` overwrites rather than closes, holding the slot `active`. A `start()`
  that goes live clears the previous failure, and `stop()` awaits the pump even when the connection
  is already gone — `#die` nulls it *before* closing it, so returning early reports a released slot
  to the supervisor that is about to start the next process.
- **`#pump` *is* the terminal cleanup, so a restart awaits it before it dials.** `#drain` awaits
  `#die` and `#die` awaits `connection.close()`, but `#die` clears `#running` and nulls
  `#connection` before that close settles: a `start()` checking `#running` alone dialled into a
  slot the dead walsender still owned and replaced `#pump` with its own, so the next `stop()`
  awaited only the new pump. `start()` takes the previous pump and awaits it first; its failure
  path calls `stop().catch(() => undefined)` because the boot diagnosis is the one an operator acts
  on and a teardown that also failed must not replace it.
- **`stop()` releases everything before it reports anything.** A `#confirm` or an `endCopy` that
  threw skipped the close and the pump await, leaking the socket and telling a supervisor the
  teardown was over before it had begun. Every step runs whatever the step before it did, and the
  first failure is rethrown only once the connection is closed and the pump has ended.
- **`REPLICA IDENTITY FULL` is asked about at preflight, warned about, and counted — never thrown**
  (added 2026-08-19). `pg-replication.ts`'s `#deliver` hands a `delete` its `message.before`,
  and under any identity but FULL that tuple is the KEY COLUMNS ALONE — which `toRow` accepts,
  because it only requires a text `id`. So `bridgeChange` decided "did this row leave the result
  set" from a one-column row, `visible` read `undefined` for every column the identity did not
  carry, and nothing anywhere recorded that it had happened: no emit, no check, and
  `X_LIVE_REPLICA_IDENTITY` existed in neither the source nor the manifest. The check is a fourth
  `connection.query` in `preflight`, and it **must** stay ahead of
  `pg_create_logical_replication_slot` — changing the identity after a slot exists does not reach
  what that slot decodes. It WARNS (`logger.warn(code, { cause, fix, tables })`, the message being
  the code alone) because a throw would stop every app on the default identity from booting, which
  is a worse outcome than the partial rows. `ReplicationStreamStats.partialBefore` is the runtime
  half, read off `PgRelation.replicaIdentity` and never off the tuple: a DEFAULT-identity table
  whose non-key columns happen to be NULL sends the bytes a FULL one does, so counting absent keys
  would undercount exactly the rows a policy is most likely to misjudge. A hard refusal in the
  `x verify` step is the follow-up and lives in `@ultimat3/cli`.
- **The replication session pins its own output formats, `As of 2026-08-23`.** Postgres sends every
  WAL value as TEXT and `pg-values.ts` reads a `timestamptz` by matching postgres' ISO spelling,
  keeping the raw text when it does not match — deliberately, because a wrong instant is worse than
  a string. That makes the SERVER's `DateStyle` load-bearing: `SQL`, `German` or `Postgres` sends
  every timestamp down the fallback, the shared window holds `Date`s while the patch holds text,
  `compareValues` falls to string comparison, and one edit to one column jumps its row to the top
  of every `orderBy('createdAt','desc')` feed for every subscriber — the exact defect the decode
  exists to close, re-opened by a GUC. `pg-connection.ts` therefore sends
  `options: '-c datestyle=ISO -c intervalstyle=postgres -c extra_float_digits=3'` in the startup
  packet, byte for byte what postgres' own logical-replication client sends
  (`libpqwalreceiver.c`) — which is why a walsender accepts it. On **every** session this class
  opens, not only the replicating one: one session shape is one thing to reason about, and the
  advisory-lock connection is the same class. A server that refuses one answers `ErrorResponse` at
  startup, so the replicator fails to boot with the server's own words rather than mis-sorting a
  feed behind a warning nobody reads. `pg-connection.test.ts` pins the packet.
- A change lsn is `<16 hex commit position><8 hex row position in that transaction>`. Never order by
  either half alone: the commit lsn repeats within a transaction, and per-record WAL positions are
  not monotonic across transactions. Never make it depend on wall time, the entity list or a process
  counter — a replay must produce byte-identical lsns or at-least-once turns into duplicate delivery.
- Slot, publication and entity names are interpolated into a replication command, so they are
  checked against `[a-z_][a-z0-9_]*` first. That regex is a security boundary, not a style rule.
- Same rule on the bus, for the half that is still ours: a bucket name is interpolated into a
  JetStream stream name and its API subjects, so it is checked first (`assertBucket` in
  `nats-jetstream.ts`, `X_TRANSPORT_PROTOCOL`). Subject validation went with the hand-rolled client —
  the library refuses a malformed subject itself, and a second spelling of that rule here is a second
  place it can drift. A presence key or member id is user data, so it is base64url-encoded
  (`encodeToken`) rather than validated — no name is refused for its spelling.
- **One row value per `(entity, id)` per client, and `identity-map.ts` is the only place one lives.**
  A live window is an ordered list of ids over that map and a local-store table is membership over
  it — neither holds a row of its own, because two components holding two copies of post #7 is the
  bug the map exists to make unrepresentable. A `LiveClient` takes the map off its store when tier 3
  is configured (`options.store.identity`) and builds one otherwise: a second map here would be that
  same duplication, one level up.
- **The scope is `(entity, id)`, never `id` alone, and the entity comes from the server.** The
  compiled shape's root entity (`live.shape.entity`) is the one name the live path, `ChangeEvent`,
  a mutator's `tx.<table>` and `rebase`'s `ack.entity` all already agree on; a browser cannot derive
  it, because the shape is compiled out of `sql`. It rides on the `snapshot` frame, and a
  subscription that is told no entity keeps its rows under `?query:<name>` — private, colliding with
  nothing. Wrong sharing merges two entities into one row; no sharing only costs a stale view.
- **`snapshot.entity` is additive, and that is why `PROTOCOL_VERSION` did NOT move.** The bump rule
  exists for a shape change that makes an old frame unreadable. This one is readable both ways — an
  old node omits the field and the client falls back to the private scope, an old client drops it in
  `decode` — so bumping would refuse every in-flight client during a rolling deploy in exchange for
  nothing. An *incompatible* frame change still bumps, and every kind still needs a fixture.
- **A value is replaced, never mutated, and a write merges columns rather than replacing the row.**
  A mutated row is a render that never happens — the projections hand rows to a signal, which
  compares by reference. And two queries may project different columns of one row, so a snapshot
  from the narrower one must not blank what the wider one is rendering. Only a `delete` removes.
- **A row lives exactly as long as something holds it.** Every projection retains its ids and
  releases them when it lets go (`RowWindows` on a re-snapshot, a patch, a close; a table on delete
  and rollback). The last release drops the value — without it an infinite scroll retains every row
  it ever saw. It is what lets a rollback of an optimistic insert leave a row a live window still
  holds: the table's membership goes, the row does not.
- `local(tx, input)` is pure: no I/O, no `Date.now()`, no `Math.random()`. Rebase replays it.
- One registered `LiveClient` per app (`setLiveClient`), and every hook reads it through that seam —
  no hook takes a client argument, and an unregistered one is `X_LIVE_CLIENT_MISSING`, never a
  lazily-constructed default.
- **A DOM is the whole of the question, and it decides what "no client" MEANS** (2026-08-23, issue
  #271). Deliberately the same rule, the same probe and the same words as `@ultimat3/ui`'s
  `solid()`: with a DOM, a hook that finds no registration is a real bug — the app entry forgot
  `setLiveClient` and every live query on the page is dead — so it stays `X_LIVE_CLIENT_MISSING`.
  Without one there is no socket a client could have been registered *for*; that is a **server
  render**, and it gets `serverRenderLiveClient()`. Before it, a page whose whole body read a live
  query could not server-render at all: `useConnection()` threw and the route answered 500, and the
  existing `hasLiveClient()` guard could not help — it only serves a component that already has a
  static fallback written. `hasLiveClient()` still answers **false** on the server, on purpose,
  because that is exactly what such a component is asking.
- **The server client serves the first render and opens no socket, so it holds nothing per
  request.** One instance per process, and that is only safe because `useLive` on it registers
  nothing: a client that kept a registration per call would grow by one entry per request forever
  and pin a row window with each. `state()` is **`loading`**, never `offline` and never `live` — the
  rows arrive over a socket this render does not have, so the page's own loading fallback is what
  the document carries. `offline` would be read as a settled answer (`state() !== 'loading'` is the
  gate a page writes), so an empty result set would render "you have no posts" for a feed that has
  some. `connected` is `true` for the mirror-image reason: `useConnection().offline` is a banner
  about this visitor's connectivity, and the request being served is the proof it is up. Everything
  that can only mean "talk to the socket" — `mutate`, `drain` — refuses with
  `X_LIVE_SERVER_RENDER`, because a dropped mutation looks exactly like one that happened.
- **The hook seam takes `LiveClientLike`, not the `LiveClient` class, and that is a measurement.**
  A value import of the class from `hooks.ts` put the whole connection lifecycle — heartbeat, topic
  book, mutation sender, wire protocol, backoff — into every island that calls `useLive`: a
  `useLive`-only browser chunk went **8,368 B → 26,571 B**. Against the structural shape it is
  9,356 B, and the ~1 kB is the server client and its refusal. `type-pins.ts`
  (`_LiveClientSatisfiesTheHookSeam`) is what keeps the two in step.
- **A server render that renders is not a live page.** A page component never runs in a browser —
  only an `island()` module does — so `useLive` in a page body server-renders its loading branch and
  nothing replaces it unless that route ships an island that registers a client. The server client
  removes the 500; it does not make a page live, and it must never be described as if it did.
  `examples/dummy`'s `/feed` is exactly that state and its own header says so.
- Anything a component reads is a **getter or an accessor**, never a value snapshotted at hook time:
  a plain field cannot re-render. `MutatorLike.local` is declared with method syntax so an
  `@ultimat3/action` `Mutator` assigns with no cast — a function-typed property would not.
- `useLive`'s thunk input is read once, at subscribe time. There is no reactive runtime here to
  re-run it, and pretending otherwise would be a silently stale subscription.
- Every subscription handle client code gets back — `LiveHandle` (`useLive`'s return, and
  `LiveRows` one layer up through the hook), `Unsubscribe` (`client.subscribe(topic, …)`'s return)
  — is `Disposable`. `[Symbol.dispose]` is the exact same function reference as `unsubscribe`,
  never a second implementation that could drift from it, so `using sub = client.useLive(...)` and
  `sub.unsubscribe()` are one teardown path either way. Pinned in `type-pins.ts`
  (`_LiveHandleIsDisposable`, `_LiveRowsIsDisposable`, `_UnsubscribeIsDisposable`) so a refactor
  that drops the member fails the build, not a call site months later.
- `liveHookFor(query)` is the typed projection the wiki promises as `useLiveFeed({ orgId })`. It
  **binds** `useLive` — it never re-implements a subscribe path, because two of those is two places
  a subscription can be opened wrong. It names `Query`'s shape structurally (`LiveQuerySource`)
  rather than importing `@ultimat3/query` as a value: a hook is browser code, and a value import
  would pull the server's read path into the bundle.
- The query's name is read **per call**, never captured at bind time. `export const useLiveFeed =
  liveHookFor(liveFeed)` runs at import; `registerQueries()` stamps the name later, at boot.
- Type claims about the hook go in `type-pins.ts`, never in a `.test.ts` — `tsconfig.json` excludes
  test files, so `tsc -b` never reads one and an assertion written there can never fail.
- **`backoffDelay` is `@ultimat3/core`'s, and `attempt + 1` is the whole of the seam** (`As of
  2026-08-23`). A client counts its first reconnect as attempt **0** and core counts the first wait
  as attempt **1**, so dropping the shift doubles every reconnect delay in the framework —
  silently, and only under the load this file exists to survive.
  `thundering-herd-core-parity.test.ts` pins it with the numbers (`[500, 1_000, 2_000, 4_000]`) and
  with 17,280 comparisons across every jitter mode, base, cap, factor, attempt and roll.
  `JitterMode` is core's type re-exported and `Rng` is core's `Random` — never a second spelling of
  either. `drainPlan()` and `AcceptBudget` are NOT backoff and keep their own arithmetic: a slot in
  a spread and a token bucket's refusal delay are different questions. `bun run flight-copies` is the
  guard: a second curve-and-jitter function anywhere in `packages/*/src` is a build error, matched
  on the literal shape rather than the name.
- **The SHARED window read carries a deadline, and it frees the SLOT — it cannot cancel the read**
  (`As of 2026-08-23`). One `definition.snapshot` that never settled pinned `entry.reading` for the
  life of the process, and every later cold subscriber joined a promise nothing would ever resolve:
  one wedged read took every future subscriber of that query id with it. `startRead` now races the
  read against `entry.schedule(…, entry.readDeadlineMs)`, default `DEFAULT_READ_DEADLINE_MS` (30s),
  injectable per entry and through `new LiveQueryRegistry({ readDeadlineMs, schedule })`. Three
  rules, each with its own test in `query-window.test.ts` and each proven by mutation:
  - **A race, not just an eviction.** Freeing the slot alone leaves every caller ALREADY joined
    awaiting a promise nothing settles; they are told instead, with `X_TIMEOUT`.
  - **`X_TIMEOUT`, not a silent empty window.** A superseded read is discarded silently because a
    strictly better window already exists to serve from; a timed-out read has none, and serving
    `rows: []` as the whole result set is the exact fault `live-query.ts`'s `#read` refuses. The
    rejecting-read path (`readSnapshot`'s catch) is the shape this matches, not the superseded one.
  - **`stale` is put back**, for `readSnapshot`'s reason: a read that did not answer must not leave
    the window looking authoritative.
  There is **no "off" spelling** — a shared read with no deadline is the defect itself — and a `0`,
  negative, `NaN` or `Infinity` value falls back to the default rather than to "now".
- The client owns its own reconnect: a closed socket arms **one** timer through the injected
  `Scheduler`, and that timer calls `connect()`. `reconnectAt` is the render half and never the
  mechanism — publishing it without arming anything is exactly the bug that shipped. Rules that
  hold the arming together: `onClose` nulls `#socket` (a retained dead socket makes `#send` a
  silent no-op), it only schedules when nothing is armed (a `reconnect` frame arms the node's
  spread slot *before* closing, and a local backoff would overwrite it), and `close()` cancels —
  a client whose owner is gone must stop dialling, while `connect()` starts it over. A close speaks
  only for **its own** socket: `onClose` returns before touching any state when `#socket` is no
  longer the socket that closed, because a replaced socket closing late must not mark the live
  connection offline or arm a backoff behind it — and `close()` therefore reports its subscriptions
  offline itself. A dial that throws inside the timer arms the next attempt and is **reported
  through `onError`** (default `console.error`; never `logger`, whose writer is `process.stderr`
  and this is browser code): a socket constructor may refuse, one refusal ending the chain is the
  same outage as never arming, and nothing awaits a timer — a throw out of one is an uncaught
  exception that can kill the process that was going to retry. Only the timer owns the chain and
  only the timer reports — a `connect()` the app called itself throws to the app and arms nothing.
- **A `sid` is CLIENT data, so a subscription is keyed by `(socket, sid)` — never by `sid` alone.**
  `LiveQueryRegistry.unsubscribe(socketId, sid)` and `.subscription(socketId, sid)` both take the
  owner. Keyed by the sid alone, socket B reusing socket A's sid overwrote A's slot: A's
  subscription stayed in its query entry's `subscribers` map with nothing able to reach it, so
  `unsubscribeSocket(A)` freed nothing, `subscribers.size` never hit zero, and the entry's matcher
  and shared window were pinned for the process's life while every change fanned out to a dead
  socket. A `{op:'drop', sid}` frame from B ended A's stream with no error on either side.
  `sync-node` passes `socket.id` on the drop path for that reason. Reusing a sid the SAME socket
  already holds is `X_SUBSCRIPTION_ID_TAKEN` — refused rather than replaced, because replacing is
  the strand. `subscription-book.ts` owns that identity and is the only place it is spelled: the
  query entry's own `subscribers` map takes the same composite key, so one `unsubscribe` reaches
  both by one identity.
- **`connect()` closes the socket it is replacing, and a frame speaks only for its own socket.**
  A remount calling `connect()` on a live client left the previous socket open: its `onMessage`
  kept folding patches into the live registrations, and the node held two sockets for one client —
  double presence membership, double fanout — until the tab closed. `#socket` is nulled before the
  close so the corpse's `onClose` takes its early return, and `onMessage` carries the same identity
  guard `onClose` already had.
- **The grant is recorded BEFORE `server.upgrade`, and released on the path that never opens.**
  Bun runs `websocket.open` SYNCHRONOUSLY inside `server.upgrade` and does not return until it has
  (bun 1.4.0), and `open` is where `sync-node` reads the `GrantBook` for the socket's actor.
  Recorded on the line after the upgrade — which it was — every authenticated socket on a real node
  carried `actor: null`: `ChannelHub.#authorize` denied every topic with `X_TOPIC_FORBIDDEN`,
  `authorize`/`visible` decided about nobody, `maxPerTenant` never applied and `hello.actorId` was
  null. It did not self-repair, because `GrantBook.expired()` skips a grant with no `expiresAt` —
  the shape `authenticate: async () => ({ actor })` produces. `onUngranted` is what makes the
  correct order safe (only a `close` callback deletes a grant, and an upgrade that never took gets
  no callback); it is REQUIRED on `UpgradeDeps`, so a second host of `handleUpgrade` cannot forget
  it. The harness is half the rule: `sync-node-auth.test.ts`'s `upgradeTarget()` returned `true`
  without ever calling `open`, so the bug was invisible to every test here — it now opens the socket
  inside `upgrade()`, the way Bun does.
- **Every `socket.send` on the node reads its answer, and what a `false` costs is decided per
  frame.** A subscribe reply is REPAIRABLE and was the silent one: `registry.subscribe` has already
  seated the subscription and cleared its desync mark, so a dropped snapshot left the server
  believing a client holding no rows was in sync, and every later change reached it as a patch
  folded onto nothing — on a healthy socket, forever. It is marked desynced, exactly as
  `live-fanout` marks a lost patch. A `rebase`/`ack` has nothing to mark (the node keeps no
  per-mutation state) and a client only returns an `inflight` mutation to its queue when the
  connection dies, so an undeliverable settlement **closes the socket**: the reconnect requeues and
  replays it under the same idempotency key, and acking a rebase that never left is the
  rebase-before-ack order defeated one frame later. A presence roster has no repair at all — the
  membership is already on the shared set and the client's next heartbeat re-rosters — so it is
  logged (`sync.presence_roster_dropped`). The drain's `reconnect` frame is the socket's slot in the
  spread and nothing re-sends it, so `drain()` returns `DrainedSocket[]` with `notified` per socket
  and logs `sync.drain_frames_dropped`.
- **A socket's actor comes from `createSyncNode({ authenticate })` and from nowhere else.** The node
  imports no authenticator — the app supplies one, exactly as it supplies `onMutate` — and it runs
  on the upgrade *before* `server.upgrade`, so a refused credential never costs a websocket.
  `null` is a **decision** (401, `X_SOCKET_UNAUTHENTICATED`, a client fault that pages nobody); a
  throw is a **failure** (503, `X_SOCKET_AUTH_UNAVAILABLE`, reported) — the same rule the row gate
  follows, one layer out. Absent, every socket is anonymous and `start()` warns: that node is
  single-tenant, and `hub.guard('org.*.feed', ({ actor }) => actor?.orgId === …)` denies everyone.
  The actor is written in exactly one place, the `GrantBook`; `WsData` deliberately carries none,
  because two spellings of one identity disagree the moment a re-auth renews one of them.
- **A grant expires; a socket does not.** `authenticate` answers a `SyncGrant`, not an `Actor`: a
  15-minute token on a socket that stays up for hours was authorized once and served forever, and
  an active client never idles out either — every inbound frame `touch()`es it. The node re-decides
  an expired grant on an interval and then calls both halves that already existed and had no
  caller: `hub.onActorChange` (topics) and `registry.reauthorize` (subscriptions). `refresh` is the
  app's closure, so the framework retains no credential of its own — re-reading the upgrade
  `Request` would mean holding one per socket. No `refresh` = close with `1008` and let the client
  re-dial. A `refresh` that **raises** keeps the socket and retries: a token service timing out is
  not a revocation.
- **`desynced` is a mark with a reader.** It is written when a patch is dropped by backpressure,
  when a gate fails, when a window loses its tail and when a re-auth survives; the *next* delivery
  serves that subscriber a fresh snapshot out of the shared window (no DB read) and only then
  clears it. A snapshot the socket refuses leaves the mark, which is the state it is in. Four
  writers and no reader was a subscription that stayed permanently and silently stale on a healthy
  socket, with the server knowing and the client not.
- **`result.refill` is checked BEFORE the mark, because a repair out of a guessed window clears it.**
  The word "fresh" above is load-bearing: when the matcher lost the window's tail, `entry.rows` is a
  guess, and the same fanout that refuses to send a *patch* derived from it was resnapshotting every
  already-desynced subscriber out of it — and clearing the one mark that would have made the next
  change re-read. That subscriber is then recorded as repaired against rows nothing trusts and gets
  a patch, not the snapshot it is still owed, from the refilled window. A lost tail degrades every
  subscriber the same way, whatever each was holding, and they are all repaired on the next change
  after `refillWindowInLane` has replaced the window. `live-fanout.test.ts` pins both halves.
- **A change the window already holds is refused on the way in.** The replicator guarded duplicates
  and out-of-order on the *publish* side; `entry.lsn = change.lsn` was unconditional on the
  *consume* side, so a redelivery rewound every subscriber's cursor. `change.lsn <= entry.lsn` is
  dropped and counted as `staleChanges`.
- **A gap in the change stream is detected, not assumed away.** Fanout is core NATS — at most once
  — and an lsn cannot reveal a gap, because a WAL position is a byte offset and every legitimate
  next change is already an arbitrary jump. The replicator stamps `producer` + `seq`; a skipped
  sequence marks every window `stale` and every subscriber desynced, and the next change to each
  query re-reads. Both fields are optional on the bus: a publisher that does not sequence detects
  nothing rather than crying gap, and a *new* producer restarts the count rather than reading as
  one. A stale window is replaced in the lane (`refillWindowInLane`) — `fillWindow` takes the
  entry's own lane and a lane is not reentrant.
- **A hub that closed opens nothing, and `#open` is the only thing that can enforce it.** `close()`
  walks `#bridges` and then clears it, which reaches every bridge that is open and none that is
  still opening: a reservation an in-flight `subscribe` has taken is `sub === null`, so
  `unsubscribeWhenOpen` does nothing to it and `clear()` drops the entry. The transport then hands a
  live subscription to a `Bridge` nothing can name — `#release` looks the topic up, misses and
  returns — and its handler keeps calling `deliver` for the life of the process. The same orphan the
  `Bridge` comment describes, one state earlier. So `close()` sets `#closed` **before** the walk and
  `#open` closes its own subscription when it lands after one, dropping the entry with it so a
  second post-close subscribe opens and closes its own rather than double-unsubscribing this handle.
  It then **raises** `X_TRANSPORT_UNAVAILABLE` rather than returning: returning let `subscribe` fall
  through to `joinTopic`, so the socket became a member of a topic nothing on this node is bridged
  to — silent for the life of the connection, no error on either side, and no reason for the client
  to redial. Reachable between `hub.close()` inside `node.drain()` and the last in-flight subscribe.
  `#release` takes the bridge the caller reserved for the same reason: after `close()` cleared the
  table, that topic name may hold a bridge a LATER subscribe opened, and releasing by name alone
  decrements somebody else's refcount.
- Deny by default on topics. No guard = `X_TOPIC_FORBIDDEN`.
- **A guard that FAILS is not a guard that denied — the hub's copy of the rule the row gate already
  follows.** On `onActorChange` (the re-auth pass) only a denial unsubscribes; anything else keeps
  the topic, increments `guardFailures` and logs `channel.guard_failed`. A guard is app code and may
  reach a database, so `catch { unsubscribe }` reported a store that timed out as a revoked grant —
  every topic on every re-authenticated socket on the node, silently, with the client never told to
  resubscribe. The initial `subscribe` is deliberately NOT split: there is no subscription to keep,
  so a raising guard refuses that subscribe and the client hears about it.
- **The `rebase` frame goes out BEFORE its `ack`, and an `ack` refers to what failed.** The ack is
  the receipt and the receipt retires the client's journal row and rebase-log entry, so a rebase
  landing after it has no entry to read `conflict` off — every merge silently becomes `server-wins`
  — and no sequence to decide which later optimistic writes to replay. Two frames on one socket:
  the order is the only coordination there is. `ackRefOf` answers the mutation key for a `mutate`
  and the sid for a `subscribe`; the socket id is only for a frame that could not be decoded, since
  `queue.fail(ref)` looks up by idempotency key and a socket id names a key no queue holds.
- **Inbound frames run in a lane, and the lane is NEVER the socket.** `sync-node.message` dispatches
  every frame as `void (async () => routeFrame(…))()`, so nothing upstream orders them. A global
  per-socket lane would put every frame behind the slowest one, and the slowest one is a subscribe's
  snapshot read — a DB round trip every reconnecting client pays once per live query, which is the
  restart storm this framework is measured on. `mutate` is one lane per socket, `subscribe` is
  `sub:<sid>` or `topic:<name>`, everything else is unlaned (`frame-lanes.ts`). A lane exists only
  while work is queued on it: keyed by a client-chosen sid, a lane that outlived its work is an
  unbounded map one socket grows at will.
- **A cap is a RESERVATION taken before the first await, never a check.** A lane makes concurrent
  frames sequential and N sequential subscribes still pass a check-then-act cap N times — and the
  per-tenant cap spans sockets, where no lane can see it at all. `SubscriptionBook.reserve(socket,
  sid)` decides the sid claim, `maxPerSocket` and `maxPerTenant` in one synchronous step;
  `ChannelHub.subscribe` does the same for `maxTopicsPerSocket`, `maxTopicsPerNode` and the node's
  bridge slot, before the guard is awaited. The tenant is captured, not re-derived — a re-auth may
  `retenant` the socket while the read is in flight, and the release has to give the slot back to
  the tenant that took it. Released in a `finally`, and releasing twice is a no-op.
- **Bun's native pub/sub is deleted, not wired.** Nothing here publishes to a native topic and
  nothing will: a native publish cannot be refused per socket, cannot report the frame it dropped
  and cannot mark a subscriber desynced. `SocketRegistry.deliver` is the one fanout path.
  `WsLike.subscribe`/`unsubscribe` stay declared and unused — a tracked app implements the
  interface structurally, so removing the members is that app's typecheck failure — and the
  declaration says so, because a member that looks live is one someone will call.
- **A dropped channel frame is counted in three places and repaired in none.** The series
  `channel_frames_dropped_total` (no attributes — a topic is client-chosen, so a per-topic label is
  unbounded series one socket can mint), the log `channel.frames_dropped` with `{ topic, dropped,
  total }`, and `SocketRegistry.droppedChannelFrames` for a test or a bench that cannot scrape.
  Node-wide because a socket past `maxDroppedFrames` is closed and removed — a per-socket count
  leaves exactly when loss is worst — and distinct from `SyncSocket.droppedFrames`, which counts
  every frame kind and dies with its socket. Repair needs a per-topic sequence on the wire: a
  channel's lsn is the publishing hub's own per-node counter, so a client cannot tell a gap from a
  message that came via another node. Declared in `socket.ts`, not core's `runtime-metrics.ts`:
  that file is the series every process emits, this one exists only where channels do.
- **A qid is `@ultimat3/query`'s `queryHash(name, input)`, and this package derives none of its
  own — `As of 2026-08`.** `qidOf` was the same two lines over a local copy of the canonical form
  (`stableDigest(canonicalJson(input))`), and `canonicalJson`/`stableDigest` were this package's
  third copy of what `@ultimat3/action` and `@ultimat3/query` also each held. They had already
  diverged: `{ a: undefined, b: 1 }` gave `feed:eb8ed3ccb5023093` from `queryHash` and
  `feed:c0bf82ad036cb0a5` from `qidOf`, because query's walk drops an `undefined`-valued key and
  this one rendered `"a":null`. The two are COMPARED in one flow — `@ultimat3/query`'s `planResume`
  decides refetch-vs-resume by comparing a cursor's `queryHash` against the query's, while
  `liveQueryDefinition` keys the shared window by the qid — so keeping both correct was never the
  option; the first time either moved, every resume decision and every window lookup were keyed
  differently. `realtime -> query` is the one declared sideways edge and this package already
  imports it. **`fnv1a` is gone too, `As of 2026-08-24`**: it stayed for one job — the cursor's
  result-set digest — and `LiveCursor.digest` was deleted for having no reader, so this package now
  owns no hash at all. A 32-bit hash nothing calls is one the next caller reaches for as a sharing
  key, which is the single thing `json.test.ts` used to pin it against.
  `live-contract.test.ts` is the pin — it reads `registry.subscriberCount(queryHash(name, input))`
  through a real subscribe, so a local derivation fails it. Cost of the move: none observable on the
  server. Every qid a node computes comes from a DECODED frame, and `JSON.parse` produces no
  `undefined`, no `Date`, no `Map` and no `Set` — the four values the two forms disagree about — so
  no live subscription re-keyed and nothing re-snapshotted.
- **The canonical form is injective over the values it accepts, and `JSON.stringify` is not** —
  the reason that survives the move, now `@ultimat3/core`'s to enforce. `JSON.stringify` answers
  `"null"` for `NaN` and `±Infinity` and `"0"` for `-0`, so four distinct inputs hashed to one qid
  — and a qid *hit* hands the joiner the first subscriber's compiled source, matcher and seated
  window. Bare `NaN` / `Infinity` / `-Infinity` / `-0` tokens are emitted instead; they are not
  valid JSON, which is correct, because that output is hashed and never parsed. Exposure is
  narrower than it looks and the tests say so rather than overclaiming: `NaN` and `±Infinity` have
  no JSON spelling and so cannot arrive on a `subscribe` frame — they reach the hash only from a
  caller building `input` in JS. **`-0` is wire-reachable**: `JSON.parse('{"a":-0}')` answers `-0`.
- **Refusing new sockets and draining the ones you have are two shutdown phases.** `stopAccepting()`
  is the `accept` phase: `ready = false`, `/readyz` 503, a late upgrade shed with `retry-after-ms`,
  and every socket untouched — a draining node still owes its clients their patches, and `stop()` is
  what releases the change subscription carrying them. `drain()` + `stop()` are the `close` phase.
  Registered with no phase, both landed in `close` and the node upgraded new websockets until the
  very end. `listenSyncNode` unregisters both on `stop()`.
- **Readiness AND the connection cap are asked twice, because `authenticate` is app code with an
  await in it.** A request that passed the checks at the top of `handleUpgrade` can be parked in a
  token service when SIGTERM lands, and the `accept` phase is over by the time it reaches
  `server.upgrade` — one more socket on a node the load balancer has already stopped routing to, so
  nothing takes it over. `ready` and the socket count are therefore **functions** on `UpgradeDeps`,
  not values read once.
  **`socketCount()` was the half that was read once and never re-asked** (2026-08-23), which is the
  same staleness with a worse blast radius: a restart storm dials every client of a dead node at
  this one at once and each parks in the token service having passed the cap while the node still
  held nothing, so `maxConnections: 2` with ten parked upgrades took **ten** sockets — reproduced,
  `upgraded 10, shed 0`. Sound because there is no await between the recheck and `server.upgrade`,
  and the count moves INSIDE it: Bun runs `websocket.open` synchronously there, which is where
  `sockets.add` runs. The recheck sheds with the same 503 + `retry-after-ms` and takes no second
  `tryAccept()`: that budget was spent.
- **A client `send` that returned is not an acknowledgement.** A browser `WebSocket.send` on a
  CLOSING socket discards the frame and returns normally, so a drained mutation is `inflight` until
  the server settles it or `requeueInflight` returns it. Only `pending` is sendable, `drain()` is one
  chained pass at a time (two overlapping passes put one key on the wire twice, and a later pass can
  overtake the one ahead of it), and backpressure over `MAX_BUFFERED_BYTES` declines rather than
  fails — the mutation stays pending and the pass stops instead of reordering the ones behind it.
- **The lane orders passes; it does not order a socket death, so the queue carries an epoch.**
  `requeueInflight` is not a pass and cannot reach into one parked at `await send(...)`: it hands
  back what was on the dead socket, the parked pass resumes and marks everything *behind* that
  mutation `inflight` for a connection that is gone. `#sendable` excludes `inflight`, so the next
  drain skips them, no ack ever arrives and the writes are lost — invariant 3 inverted. `#epoch` is
  bumped before the requeue scan and read at the top of every `#pass` iteration; a pass whose epoch
  went stale returns and leaves the rest `pending` for the connection that arms the next one.
- **`#persist` hands the store a SNAPSHOT, never the live entries.** `QueueStore.save` is a durable
  write (OPFS, IndexedDB) and may await before it reads. Given the array itself, a store that
  resolves after the next pass has moved on persists a status that was never true when it was
  called — and `inflight` is the one a reload cannot recover from.
- **A reconnect replays registrations AND topics, and every socket handler carries the identity
  guard.** A reconnect is one `hello` plus one frame per thing this client holds: a `subscribe` per
  registration, carrying that registration's cursor, and a `subscribe` per topic. Topic membership
  is state on the node's socket, so a channel is silent from the first reconnect while its handler
  is still installed — and its presence membership is swept — unless every one is re-announced.
  `onOpen` needed the `#socket !== socket` guard `onMessage` and `onClose` already had: a replaced
  socket opening late marked the connection up and replayed every subscription onto the current one.
- **`hello` carries NO cursors, and `HelloFrame.resume` is deleted (2026-08).** It was filled by
  every client on open and read by nobody — the node replied `resume: []` and decided resume per
  subscription from the `subscribe` frame — so every reconnect shipped each cursor twice, up to 512
  ids each, in the restart storm this package is measured on. Wiring it was the wrong half of the
  choice: a cursor's `qid` is `` `${name}:${fingerprint(input)}` ``, so a node reading a resume list
  recovers the query **name** — it is the plaintext prefix — but never the `input`, which is the half
  every decision needs. Without it `definition.authorize({ actor, input })` cannot run and no entry
  can be built; the qid names a window but not a decision, and the retained window holds pre-policy
  patches, so answering from it at `hello` time means answering before the per-subscriber
  authorization pass, for a subscription that does not exist yet. It could only ever restate,
  unauthorized, what `subscribe` decides with the input in hand — and it could not even save the
  bytes, because the cursor still has to ride its `subscribe`. Two places deciding one thing is what axiom 1 refuses. **`PROTOCOL_VERSION` did NOT
  move**, same rule as `snapshot.entity`: `decode` is a whitelist, so a new node drops an old
  client's `resume` and an old node reads a new client's omission as the empty list it always got.
  The one deploy of skew costs nothing in either direction.
- **The client beats, because only the client can end a half-open socket.** `heartbeatMs` (default
  `DEFAULT_HEARTBEAT_MS`, 15s; `0` disables) sends a `hello` — byte-identical to the opening one,
  since the frame has no resume list to leave out — plus one subscribe frame per topic, which is the
  node's presence heartbeat. It is **not** how a deploy is noticed: `socket.skewed` compares the
  build id recorded at the upgrade against this node's, both fixed for the socket's life, so every
  `hello` on one socket answers the same forever and `update-available` reaches a client on the
  socket it opens against the *new* node. Two silent windows and the client closes with `4000` and
  arms the reconnect. It is one
  self-re-arming tick on the injected `Scheduler`, not an interval: a client is either beating on a
  live socket or backing off toward a new one, never both. The 15s is the client's OWN number:
  `realtime.heartbeatMs` was a `RealtimeConfig` key read by nothing and it is **deleted**
  (2026-08-19). The server half of the beat stays derived — `PresenceRegistry.heartbeatMs` is
  `max(1000, floor(ttlMs / 3))`, the same rule `idleSweepPeriodMs` follows, because a second knob
  is a second number that can disagree with the one it is a fraction of.
- **Every question a hot path asks is indexed, never scanned.** `SubscriptionBook` keeps
  `#bySocket` and a per-tenant count beside `#bySid`, and `SocketRegistry` keeps `#byTopic` beside
  the socket table. Both replaced a walk of the whole node that ran once per socket or once per
  frame: `ofSocket` filtered a copy of every subscription (100,000 entries measured at **17.7s** of
  blocking work per teardown or re-auth sweep — a deploy or a batch of grants expiring together is
  the whole trigger), and the per-tenant cap walked the same map on **every subscribe frame**
  (7.96 ms each at that size). A new index goes where the deaths are seen: topic membership is the
  registry's because `remove` is the one path a close, a drain and the idle sweep all take, and
  `joinTopic`/`leaveTopic` are the only way to change it — two call sites for one membership is how
  an index goes wrong. When an actor changes, `reauthorize` calls `book.retenant(socket)`: an index
  nobody updates is a count that drifts for the rest of the process.
- **A ceiling per resource, and the wire's are not options.** `README.md` has the table. The rule
  behind it: the accept budget bounds the accept *rate*, so the *count* needs its own
  (`maxConnections`, shed as the same 503 + `retry-after-ms`); a socket that is open needs a frame
  budget (`socket.frameBudget`, checked at the top of `routeFrame` **before `touch()`** — a frame
  this node refuses must not renew the idle window); and anything a client sizes is bounded in
  `decode` by `FRAME_LIMITS`, which a caller may narrow but never widen. `list()` takes a required
  `max` so a new array field on a new frame cannot ship without someone choosing its size.
  `input` is walked ITERATIVELY: the thing being refused is a stack overflow in `canonicalJson`, so
  a recursive check would be the same crash one frame earlier.
- **Every ceiling on a socket `sync` builds is reachable from `createSyncNode`.** The node
  constructs every `SyncSocket` it holds, so a `SyncSocketOptions` the node does not forward is a
  number an operator can only change by abandoning `createSyncNode` — which is what
  `maxBufferedBytes` and `maxDroppedFrames` were until 2026-08. Forwarded the same way
  `maxFramesPerSecond`/`frameBurst` already are (`...(x === undefined ? {} : { x })`, so an unset
  option keeps `SyncSocket`'s own default rather than overwriting it with `undefined`).
- **One socket's buffer has one number on the server and a separate one in the browser.**
  `DEFAULT_MAX_BUFFERED_BYTES` (`socket.ts`) is both `SyncSocket`'s send-side ceiling and the
  `backpressureLimit` `sync-node.ts` hands Bun — two spellings of one buffer on one side, and the
  runtime's limit set lower means our check never fires and a frame is dropped with nothing marked
  desynced. `client-mutations.ts`'s `MAX_BUFFERED_BYTES` is deliberately *not* imported from it:
  that is browser code and `socket.ts` is the node's registry, its metrics and its close codes.
  `sync-limits.test.ts` pins the server pair through behaviour, not by comparing two constants that
  are now one declaration — an equality between them is a test that cannot fail.
- **A `SubscriptionLimitError` names the knob, never the default.** `knob` defaults to
  `maxPerSocket`/`maxPerTenant`, which are `LiveQueryRegistry`'s — so the channel hub's per-socket
  *topic* cap, thrown without one, told an operator to move a number in a different constructor
  that would not have helped. Every throw site passes `knob` explicitly (`maxTopicsPerSocket`,
  `maxTopicsPerNode`, `maxEntries`, `maxPerSocket`, `maxPerTenant`); `channel.test.ts` asserts the
  two hub ones against the option names, because a fix line naming the wrong setting is worse than
  no fix line — it is an instruction that runs and changes nothing.
- **Retained memory is bounded by BYTES.** `RingChangeBuffer` keeps the patch-count cap as a
  *replay* bound (what a delta resume costs to fold) and adds the byte budgets as the memory one —
  `packages/cache/src/lru.ts:1-2` states why: 4,096 queries x 1,024 patches is 4.19M retained rows
  and no number of bytes at all. `forget(qid)` is called by `LiveQueryRegistry.unsubscribe` when the
  last subscriber of a query id goes; it had no caller, so the ring outlived the entry.
- **An error never renders a value that carries a credential.** `parsePgUrl` names `DATABASE_URL`
  rather than echoing the URL it refused — an error reaches a log, `--json`, an agent transcript
  and a ticket, and the password is in the string. Same rule as `packages/mail/src/driver-smtp.ts`.
- **A full presence frame is capped and says so; the set behind it is never capped.** `roster()` is
  what a frame carries (`maxMembers`, 256, plus `total`); `list()` stays whole because the sweep
  differences it, and a short list would report every member past the cap as having left. `total`
  is set on `sync` only — a `join`/`leave`/`update` frame is a delta, and a count beside one reads
  as truncation.
- **One node per topic sweeps.** Every node sweeping every room it has seen is one full-set read
  multiplied by the fleet, and the same `leave` frame published N times. The election needs no
  compare-and-set the shared store does not have: the lease key is a *keyed set*, so each node's
  claim is its own member and the leader is the lowest id every claimant can see. Eventually
  consistent on purpose — the worst case is a duplicate `leave` for someone already gone.
- **Money is THREE physical columns on the wire too, and a live row must equal a repository row.**
  `entityRow` folds `<p>_minor`/`<p>_currency`/`<p>_scale` into one property. It matched two, so a
  scaled amount arrived at every subscriber unscaled *and* carrying a stray physical `priceScale`
  beside `price` — one row, two shapes, no error anywhere. NULL and absent both mean **no `scale`
  key**, never `0` (that is whole units, a 100x reinterpretation of an ordinary price), which is
  exactly what `@ultimat3/entity`'s `moneyOf` does. That equality is the pin:
  `pg-entity-row-parity.test.ts` reads one physical row through both surfaces — this package's fold
  and a real `postgresRepo` — and asserts one object, each side absolutely as well as against the
  other, because equality alone is satisfied by both failing open together. It is the one test here
  that imports `@ultimat3/entity` (tier 2, a legal downward edge, test-only: `*.test.ts` never
  ships), and it has to, or the thing being compared against is a copy of the reader instead of the
  reader. The `0…15` scale bound stays `@ultimat3/schema`'s — enforced by the column CHECK and by
  `parseScale`, never restated here.
- Never a bare `Error`. Never `any`. Never `Date.now()` — take a `Clock` (`clock.now()` is a `Date`;
  use `monotonic()` for durations).
- **A test fixture standing in for a FOREIGN error extends `Error` on purpose, and that is not the
  bare-`Error` rule being broken.** `PoolTimeout`, `Denied`, `MutationFailed` and `ThirdPartySdkError`
  (nine sites across `realtime`, `db` and `ai`) simulate a driver, a policy library or an app's
  `onMutate` — values this package did not construct and must handle anyway. `isPolicyDenial`,
  `stringField` and `renderThrowable` all exist *because* such values arrive; rebuilt as
  `UltimateError`s the fixture would prove the framework handles its own errors, which is the
  "equality satisfied by both sides failing open together" failure the row-parity test names. The
  rule governs what this package **throws**, never what a test hands it.

## Map

| File | Owns |
|---|---|
| `index.ts` | the `.` barrel: the client half, and the only thing a browser island may import |
| `server.ts` | the `./server` barrel: the bus, the WAL path, the node. Disjoint from `index.ts` by test |
| `sync-protocol.ts` | the wire: 10 frame kinds, `encode`/`decode`, `PROTOCOL_VERSION` |
| `channel.ts` / `presence.ts` / `socket.ts` | tier 1 |
| `live-query.ts` / `live-definition.ts` / `changefeed.ts` / `changefeed-env.ts` / `replicator.ts` / `pg-advisory-lock.ts` / `fanout.ts` / `transport-env.ts` / `matcher-bridge.ts` | tier 2 |
| `pg-bytes.ts` / `pg-wire.ts` / `pg-auth.ts` / `pg-connection.ts` / `pg-socket.ts` | the Postgres v3 client: bytes, frames, SASL, session, socket |
| `pgoutput.ts` / `pg-entity-row.ts` / `pg-replication.ts` | WAL decode → `ChangeEvent`, and the lsn that orders it |
| `pg-preflight.ts` | the four questions asked before `START_REPLICATION` — `wal_level`, the publication, every entity's replica identity, the slot — plus `assertIdentifier`, the charset all four interpolate through |
| `nats-client.ts` | the bus port: publish/subscribe/request/requestMany/close/version/connected, and `parseNatsUrl` — the library takes `host:port` plus credentials and never reads a URL's userinfo |
| `nats-lib-client.ts` | the `nats` adapter — **the only file in the repo that imports `nats`** |
| `nats-jetstream.ts` / `nats-kv.ts` / `nats-transport.ts` | the JetStream KV bucket, presence over it, and the production `Transport` — all three written against the port |
| `nats-fake.ts` | an in-memory bus implementing the port — server semantics, not wire bytes; the only way to prove multi-node fanout under a sealed network |
| `cursor.ts` / `change-buffer.ts` / `thundering-herd.ts` | reconnect — the highest-risk area. `thundering-herd.ts`'s backoff is core's, shifted 0-based to 1-based; the drain plan and the accept budget are its own |
| `identity-map.ts` | the client's single source of truth: one row value per `(scope, id)`, its holds and its batched change notification |
| `live-rows.ts` | one subscription's window over that map — its scope, its order, its retain/release, and `Registration` itself |
| `local-store.ts` / `offline-queue.ts` / `rebase.ts` | tier 3 |
| `client.ts` / `sync-node.ts` | the two halves — connection lifecycle, subscriptions, mutations |
| `sync-auth.ts` | what a socket's identity IS (`SyncGrant`), the book that holds one per socket, and the pass that re-decides an expired one |
| `sync-frames.ts` | what a RECEIVED frame does to server state — the node's inbound surface, and the mirror of `client-frames.ts` |
| `sync-upgrade.ts` | the node's HTTP surface: `/healthz`, `/readyz`, load shedding, and the authenticated upgrade — `WsData` and `UpgradeTarget` are declared with the decision that builds them |
| `sync-listen.ts` | binding a node to `Bun.serve` and to the shutdown hook — the only `Bun.serve` in the package |
| `drain-evictions.ts` | evicting every socket a drain holds, in bounded chunks, and waiting out the presence leaves each eviction started |
| `query-window.ts` | the shared pre-policy window per query id: built once, read once for N subscribers, and replaced when it is known to be wrong |
| `client-frames.ts` | what a RECEIVED frame does to client state, and `ClientFrameTarget` — the only inbound surface the client exposes. The mirror of `sync-frames.ts` |
| `client-harness-fixture.ts` | the injected socket + scheduler + harness both client suites drive. Excluded from the tarball |
| `hooks-fixture.ts` | the same, for the two hook suites (`hooks.test.ts`, `hooks-identity.test.ts`). Excluded from the tarball |
| `subscription-book.ts` | who holds which subscription, keyed by `(socket, sid)`, and the per-socket/per-tenant caps answered from it |
| `apply-patches.ts` | folding a patch list onto a row list (`applyPatches`) or onto ids alone (`orderAfterPatches`, what a window uses) — the client's one stateless piece, and one fold, not two |
| `hooks.ts` | the ambient client seam + the four component hooks — the only file an app imports |
| `query-hook.ts` | the typed projection: one declared query bound to one named hook |
| `type-pins.ts` | compile-time assertions `tsc` checks — the hook's input type, its row type, the `Query` seam |
| `window-lock.ts` | one FIFO lane per query id — the only thing that orders a fanout |
| `frame-lanes.ts` | the order one socket's INBOUND frames are applied in, and the lane key each kind belongs to. `WindowLock` again, keyed differently — and it bounds no cap |
| `live-fanout.ts` | what one change does inside one entry's lane: match, fold, one policy pass per subscriber, and the re-snapshot that repairs a desynced one |
| `client-mutations.ts` | the outbound mutation path — the optimistic twin, the rebase entry, the queue entry, and the sender the drain hands each frame to |
| `client-heartbeat.ts` | when to beat and when to give up. A policy, which is why it is not in `client.ts`'s connection lifecycle |
| `client-topics.ts` | the client's channel book, and the one membership frame its two callers (`subscribe`, the reconnect replay) must never spell differently |
| `client-contract.ts` | the client's injected shapes — `ClientSocket`, `LiveClientOptions`, `LiveHandle` — declared apart from the class that consumes them |
| `policy-gate.ts` | the only authz seam |
| `subscriber-gate.ts` | the per-subscriber pass of a definition's row policy, and its two counters — `rowsDenied` and `gateFailures`. Evaluates no policy of its own |
| `live-contract.ts` | what a live query IS: `LiveQueryDefinition`, `SnapshotResult`, `LiveSubscription`. Four modules need the shape and none of them needs the registry that runs it. The **id** is not here and not anywhere in this package — it is `@ultimat3/query`'s `queryHash` |
| `json.ts` | the wire's value types. **No hash**: the canonical form and the sharing-key hash are `@ultimat3/core`'s (`canonicalJson`, `fingerprint`), and the 32-bit `fnv1a` that stayed for `LiveCursor.digest` went with it (2026-08-24) |
| `live-definition.ts` | the only bridge from a declared `query({ live: true })` to a registrable definition — and `policy-gate.ts`'s only caller |
| `matcher-bridge.ts` | the only `@ultimat3/query` matcher seam — and where a patch row is narrowed to the columns the query returned |

## Commands

```
bun test packages/realtime/src            # from the REPO ROOT, never from packages/realtime
bun run typecheck
```

**The root is not a preference.** `bunfig.toml`'s preload installs `@ultimat3/testing`'s matchers
and Bun reads `bunfig.toml` from the cwd, so `bun test` inside this directory loads none and six
tests fail on a missing matcher — this package's suite reading red for the shell it was run in.
CI's `package` job spawns `bun test packages/<pkg>` with `cwd` at the root for the same reason.

Changing a frame shape means adding a fixture to `sync-protocol.test.ts` — the round-trip test
fails if a kind has no fixture — and bumping `PROTOCOL_VERSION` **when the change makes an old
frame unreadable in either direction**. An *additive optional* field (`snapshot.entity`, 2026-08)
is not that: `decode` builds a whitelist, so an old client drops it and a new client reads its
absence as a defined answer. Neither is *removing a field nothing read* (`hello.resume`, 2026-08):
the same whitelist drops an old client's copy, and a new client's omission decodes to what the
field always held. Bumping for either refuses every in-flight client on a rolling deploy and buys
nothing — the version guards incompatibility, not novelty. Removing a field something *does* read
is the opposite case and bumps.

**"Nothing read it" is decided by the DECODER, not by the callers — and that half is what moved
`PROTOCOL_VERSION` to 2 (2026-08-24, BREAKING).** `hello.resume` was free because `decode` read it
through `list()`, which answers `[]` for an absent field; `cursor.digest` and `cursor.count` were
read through `str()` and `num()`, which **throw**. So deleting two fields no *caller* consumed
still made the frame unreadable to a peer one deploy behind — in **both** directions, since a
cursor rides the client's `subscribe` and the node's `snapshot`. Without the bump the skew shows up
as a per-frame `field "digest" must be a string`, which is the same refusal with none of the
instruction. Before claiming a removal is free, read the field's line in `decode`: a `list()` is
free, a `str()`/`num()` is a bump.

**A patch carries the result set's columns, never the table's** — `narrowRow` in
`matcher-bridge.ts`, `As of 2026-08-20`. A `ChangeEvent` carries the whole TABLE row (that is what
logical replication emits, and what `@ultimat3/entity`'s `setRowObserver` emits), while a live
query's result set is whatever its `sql` returned. Every patch used to forward the change row
unnarrowed, so a column a projection exists to withhold went out on the socket the moment it
CHANGED — `examples/dummy`'s feed projects ten columns and one publish delivered `updatedAt` to
every subscriber (#230). The per-subscriber gate cannot help: it decides whether a ROW is delivered,
never which of its columns.

`id` always survives the narrowing — it is the row's identity on the wire, and `applyToWindow` and
every client store key by it. An **unknown** projection narrows nothing, because "nothing has been
read yet" is not "the result set has no columns".

The projection is **learned from the query's own reads**, in `live-definition.ts`: a projection
lives inside the `sql` provider's closure and there is nothing static to read it from. Learned and
kept rather than re-derived per fanout, because the case the window's own rows cannot answer is an
EMPTY window — the first row to arrive would otherwise go out whole.
