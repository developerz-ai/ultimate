# @ultimat3/realtime — agent notes

Tier 3 package. Channels, live queries, local-first sync. One protocol for all three.

## Boundary

| May import | Must not |
|---|---|
| `@ultimat3/core`, `@ultimat3/query` | anything tier 4+ (`render`, `pwa`, `mcp`, `ui`, `cli`) |
| `@ultimat3/policy` **only via** `@ultimat3/query`'s `guard` | a second authz path of any kind |
| — | `solid-js` (the client takes an injected signal factory) |
| — | external deps. Bun natives only |

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
  a list of every read this app declares. It is a client fault, so it never pages anyone.
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
- The row policy always sees the *whole* row from the shared window, never a partial patch.
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
  gives each entry a FIFO lane; `deliver` takes one entry's lane at a time, never two at once, and
  every caller visits entries in the same order, so a queue is never a cycle. The lane chains on a
  settled shadow of each task: one fanout that threw must not reject every fanout behind it.
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
- One place reads `NATS_URL`, and it is `selectTransport` — a boot that resolved the bus itself
  could reach a different one than the container it is standing in for. The KV bucket and the
  presence TTL come back with the transport for the same reason: they are one decision.
- `sync` is stateless: no sticky sessions, nothing on a socket survives a restart.
- Exactly one `replicator` per DB, enforced by a session-level advisory lock.
- A change lsn is `<16 hex commit position><8 hex row position in that transaction>`. Never order by
  either half alone: the commit lsn repeats within a transaction, and per-record WAL positions are
  not monotonic across transactions. Never make it depend on wall time, the entity list or a process
  counter — a replay must produce byte-identical lsns or at-least-once turns into duplicate delivery.
- Slot, publication and entity names are interpolated into a replication command, so they are
  checked against `[a-z_][a-z0-9_]*` first. That regex is a security boundary, not a style rule.
- Same rule on the bus: a subject or bucket name goes straight into a NATS control line, so it is
  checked first (`assertSubject`, `assertBucket`). A presence key or member id is user data, so it
  is base64url-encoded (`encodeToken`) rather than validated — no name is refused for its spelling.
- `local(tx, input)` is pure: no I/O, no `Date.now()`, no `Math.random()`. Rebase replays it.
- One registered `LiveClient` per app (`setLiveClient`), and every hook reads it through that seam —
  no hook takes a client argument, and an unregistered one is `X_LIVE_CLIENT_MISSING`, never a
  lazily-constructed default.
- Anything a component reads is a **getter or an accessor**, never a value snapshotted at hook time:
  a plain field cannot re-render. `MutatorLike.local` is declared with method syntax so an
  `@ultimat3/action` `Mutator` assigns with no cast — a function-typed property would not.
- `useLive`'s thunk input is read once, at subscribe time. There is no reactive runtime here to
  re-run it, and pretending otherwise would be a silently stale subscription.
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
  a client whose owner is gone must stop dialling, while `connect()` starts it over. A dial that
  throws inside the timer arms the next attempt before rethrowing: a socket constructor may refuse,
  and one refusal ending the chain is the same outage as never arming. Only the timer owns the
  chain — a `connect()` the app called itself throws to the app and arms nothing.
- Deny by default on topics. No guard = `X_TOPIC_FORBIDDEN`.
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
| `nats-protocol.ts` / `nats-commands.ts` / `nats-socket.ts` / `nats-connection.ts` | the NATS client: decode, encode, socket, session |
| `nats-jetstream.ts` / `nats-kv.ts` / `nats-transport.ts` | the JetStream KV bucket, presence over it, and the production `Transport` |
| `nats-fake.ts` | an in-memory nats-server — the only way to prove multi-node fanout under a sealed network |
| `cursor.ts` / `change-buffer.ts` / `thundering-herd.ts` | reconnect — the highest-risk area |
| `local-store.ts` / `offline-queue.ts` / `rebase.ts` | tier 3 |
| `client.ts` / `sync-node.ts` | the two halves — `client.test.ts` owns the reconnect timer |
| `apply-patches.ts` | folding a patch list onto a row list — the client's one stateless piece |
| `hooks.ts` | the ambient client seam + the four component hooks — the only file an app imports |
| `query-hook.ts` | the typed projection: one declared query bound to one named hook |
| `type-pins.ts` | compile-time assertions `tsc` checks — the hook's input type, its row type, the `Query` seam |
| `window-lock.ts` | one FIFO lane per query id — the only thing that orders a fanout |
| `policy-gate.ts` | the only authz seam |
| `subscriber-gate.ts` | the per-subscriber pass of a definition's row policy, and its two counters — `rowsDenied` and `gateFailures`. Evaluates no policy of its own |
| `live-definition.ts` | the only bridge from a declared `query({ live: true })` to a registrable definition — and `policy-gate.ts`'s only caller |
| `matcher-bridge.ts` | the only `@ultimat3/query` matcher seam |

## Commands

```
bun test                                  # from packages/realtime
bun run typecheck
```

Changing a frame shape means bumping `PROTOCOL_VERSION` and adding a fixture to
`sync-protocol.test.ts` — the round-trip test fails if a kind has no fixture.
