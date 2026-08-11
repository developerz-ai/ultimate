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
- What `liveQueryDefinition` caches per query id is the compiled source, the shape, the matcher and
  the shared row window. What it must never cache is a decision. It builds that shared half with
  `enforce: false` **on purpose**: a source compiled under the first subscriber's authority and
  then keyed by query id is that subscriber's entitlements becoming everyone's. `authorize` is
  still the subscribe-time decision and still runs per socket.
- Every policy call in `live-query.ts` takes a `Subscriber`. That is the enforcement: there is no
  path through the gate that reads a query id and no actor.
- The row policy always sees the *whole* row from the shared window, never a partial patch.
- The retained change window stores **pre-policy** patches; resume re-filters them per subscriber.
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
| `client.ts` / `sync-node.ts` | the two halves |
| `hooks.ts` | the ambient client seam + the four component hooks — the only file an app imports |
| `policy-gate.ts` | the only authz seam |
| `live-definition.ts` | the only bridge from a declared `query({ live: true })` to a registrable definition — and `policy-gate.ts`'s only caller |
| `matcher-bridge.ts` | the only `@ultimat3/query` matcher seam |

## Commands

```
bun test                                  # from packages/realtime
bun run typecheck
```

Changing a frame shape means bumping `PROTOCOL_VERSION` and adding a fixture to
`sync-protocol.test.ts` — the round-trip test fails if a kind has no fixture.
