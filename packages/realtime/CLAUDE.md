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

- Policy is evaluated **once per subscriber**, never once per query. `live-query.test.ts` proves it
  for a hand-written definition and `live-definition.test.ts` proves it for a real declared
  `query({ live: true })` — the second one matters, because a rule that only holds for test fakes
  is a rule no declaration can reach.
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
- One place reads `NATS_URL`, and it is `selectTransport` — a boot that resolved the bus itself
  could reach a different one than the container it is standing in for. The KV bucket and the
  presence TTL come back with the transport for the same reason: they are one decision.
- `sync` is stateless: no sticky sessions, nothing on a socket survives a restart.
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
- Deny by default on topics. No guard = `X_TOPIC_FORBIDDEN`.
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

## Map

| File | Owns |
|---|---|
| `sync-protocol.ts` | the wire: 10 frame kinds, `encode`/`decode`, `PROTOCOL_VERSION` |
| `channel.ts` / `presence.ts` / `socket.ts` | tier 1 |
| `live-query.ts` / `live-definition.ts` / `changefeed.ts` / `changefeed-env.ts` / `replicator.ts` / `pg-advisory-lock.ts` / `fanout.ts` / `transport-env.ts` / `matcher-bridge.ts` | tier 2 |
| `pg-bytes.ts` / `pg-wire.ts` / `pg-auth.ts` / `pg-connection.ts` / `pg-socket.ts` | the Postgres v3 client: bytes, frames, SASL, session, socket |
| `pgoutput.ts` / `pg-entity-row.ts` / `pg-replication.ts` | WAL decode → `ChangeEvent`, and the lsn that orders it |
| `nats-client.ts` | the bus port: publish/subscribe/request/requestMany/close/version/connected, and `parseNatsUrl` — the library takes `host:port` plus credentials and never reads a URL's userinfo |
| `nats-lib-client.ts` | the `nats` adapter — **the only file in the repo that imports `nats`** |
| `nats-jetstream.ts` / `nats-kv.ts` / `nats-transport.ts` | the JetStream KV bucket, presence over it, and the production `Transport` — all three written against the port |
| `nats-fake.ts` | an in-memory bus implementing the port — server semantics, not wire bytes; the only way to prove multi-node fanout under a sealed network |
| `cursor.ts` / `change-buffer.ts` / `thundering-herd.ts` | reconnect — the highest-risk area |
| `identity-map.ts` | the client's single source of truth: one row value per `(scope, id)`, its holds and its batched change notification |
| `live-rows.ts` | one subscription's window over that map — its scope, its order, its retain/release, and `Registration` itself |
| `local-store.ts` / `offline-queue.ts` / `rebase.ts` | tier 3 |
| `client.ts` / `sync-node.ts` | the two halves — connection lifecycle, subscriptions, mutations |
| `sync-auth.ts` | what a socket's identity IS (`SyncGrant`), the book that holds one per socket, and the pass that re-decides an expired one |
| `sync-frames.ts` | what a RECEIVED frame does to server state — the node's inbound surface, and the mirror of `client-frames.ts` |
| `sync-listen.ts` | binding a node to `Bun.serve` and to the shutdown hook — the only `Bun.serve` in the package |
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
| `policy-gate.ts` | the only authz seam |
| `subscriber-gate.ts` | the per-subscriber pass of a definition's row policy, and its two counters — `rowsDenied` and `gateFailures`. Evaluates no policy of its own |
| `live-contract.ts` | what a live query IS: `qidOf`, `LiveQueryDefinition`, `SnapshotResult`, `LiveSubscription`. Four modules need the shape and none of them needs the registry that runs it |
| `live-definition.ts` | the only bridge from a declared `query({ live: true })` to a registrable definition — and `policy-gate.ts`'s only caller |
| `matcher-bridge.ts` | the only `@ultimat3/query` matcher seam |

## Commands

```
bun test                                  # from packages/realtime
bun run typecheck
```

Changing a frame shape means adding a fixture to `sync-protocol.test.ts` — the round-trip test
fails if a kind has no fixture — and bumping `PROTOCOL_VERSION` **when the change makes an old
frame unreadable in either direction**. An *additive optional* field (`snapshot.entity`, 2026-08)
is not that: `decode` builds a whitelist, so an old client drops it and a new client reads its
absence as a defined answer. Bumping for one refuses every in-flight client on a rolling deploy
and buys nothing — the version guards incompatibility, not novelty.
