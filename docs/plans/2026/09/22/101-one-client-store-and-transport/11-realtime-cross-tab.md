# 11 — One socket per origin across tabs

> Part of [`overview.md`](overview.md). Depends on: 09, 10, 03. Tier: 3.

Without this, sockets = tabs × (whatever one tab opens); with slice 06 one tab opens one, so N tabs open N, each counted against the sync node's `AcceptBudget`.

## Files to change
- `packages/realtime/src/tab-leader.ts` (new) — leader election with a Web Locks lock held for the tab's lifetime (`navigator.locks.request(name, () => never-resolving)`); lock name includes the principal scope (slice 03) so two signed-in accounts never share a socket. No Web Locks → every tab leads (degrades to one socket per tab, never to zero).
- `packages/realtime/src/tab-relay.ts` (new) — `BroadcastChannel` per scope: followers post `want { channels }`; the leader subscribes to the union, relays every frame; leader loss (lock handed over) → new leader subscribes the union and the other tabs' cursors (slice 10) re-sync by catch-up.
- Store stays **per tab** (Solid reactivity is per realm); only the socket and frames are shared. Writes stay per tab over HTTP (slice 08); the resulting records reach other tabs as channel frames through the leader — one path.
- `packages/realtime/src/browser-socket.ts` (slice 06) — constructed only by the leader.

## Steps
1. Leader + relay, behind the page client; islands see no API change.
2. Scope change → leave the old lock/channel, join the new.

## Tests
- `tab-leader.test.ts` with in-memory fakes of `navigator.locks` and `BroadcastChannel`: one leader; leader release promotes a follower; no locks → all lead.
- `tab-relay.test.ts`: follower's `want` subscribes via leader; unsubscribe only when no tab wants the channel.
- e2e (slice 16): two tabs, one `/_x/sync` upgrade.

## Done when
- Two tabs on the reference app hold one socket; closing the leader tab keeps the other live within one reconnect.
