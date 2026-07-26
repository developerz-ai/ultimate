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

- Policy is evaluated **once per subscriber**, never once per query. `live-query.test.ts` proves it.
- The row policy always sees the *whole* row from the shared window, never a partial patch.
- The retained change window stores **pre-policy** patches; resume re-filters them per subscriber.
- Truth is the server. A client is never the merge authority.
- Presence lives in `transport.shared`, never in a node's heap — it must survive a node loss.
- `sync` is stateless: no sticky sessions, nothing on a socket survives a restart.
- Exactly one `replicator` per DB, enforced by a session-level advisory lock.
- `local(tx, input)` is pure: no I/O, no `Date.now()`, no `Math.random()`. Rebase replays it.
- Deny by default on topics. No guard = `X_TOPIC_FORBIDDEN`.
- Never a bare `Error`. Never `any`. Never `Date.now()` — take a `Clock` (`clock.now()` is a `Date`;
  use `monotonic()` for durations).

## Map

| File | Owns |
|---|---|
| `sync-protocol.ts` | the wire: 10 frame kinds, `encode`/`decode`, `PROTOCOL_VERSION` |
| `channel.ts` / `presence.ts` / `socket.ts` | tier 1 |
| `live-query.ts` / `changefeed.ts` / `replicator.ts` / `fanout.ts` / `matcher-bridge.ts` | tier 2 |
| `cursor.ts` / `change-buffer.ts` / `thundering-herd.ts` | reconnect — the highest-risk area |
| `local-store.ts` / `offline-queue.ts` / `rebase.ts` | tier 3 |
| `client.ts` / `sync-node.ts` | the two halves |
| `policy-gate.ts` | the only authz seam |
| `matcher-bridge.ts` | the only `@ultimat3/query` matcher seam |

## Commands

```
bun test                                  # from packages/realtime
bun run typecheck
```

Changing a frame shape means bumping `PROTOCOL_VERSION` and adding a fixture to
`sync-protocol.test.ts` — the round-trip test fails if a kind has no fixture.
