# Realtime agent notes — the long form

The full text of rules `packages/realtime/CLAUDE.md` keeps as one line each, moved here 2026-11-09
to keep that file under its 24 KB ceiling. The rule is the CLAUDE.md line; this is its detail.

## Origin check

- **An upgrade from another origin is `403 X_SOCKET_ORIGIN_REFUSED`** before `authenticate`
  (`sync-origin.ts`): `allowedOrigins`, when declared, is the WHOLE list (`sec-fetch-site` unread); undeclared, the
  `Host`-derived origin (and its `https` spelling when reached over plain http). The refusal names
  the asker and the list. `x dev` keeps the reached-on origin (`admitReachedOrigin`) and adds
  its web role's beside a declared list; a container adds nothing. `AcceptBudget` is reserved before
  `authenticate`, `refund()`ed on every exit that takes no socket.

## Presence

- Presence lives in `transport.shared`. The sync node is `PresenceRegistry`'s only caller:
  subscribing to a topic IS joining, repeating the frame is the heartbeat, dropping or closing is the
  leave. Expiry is silent, so the node sweeps on an interval, and **one node per topic sweeps** (lowest
  id in the lease's keyed set; the lease carries the roster followers record). `roster()` caps a frame at `maxMembers` (256) with `total`;
  `list()` is never capped. `total` is set on `sync` frames only.

## The client's reconnect

- **The client owns its reconnect**: a closed socket arms ONE timer through the injected `Scheduler`
  that calls `connect()`. `onClose` nulls `#socket`, schedules only when nothing is armed (a
  `reconnect` frame's slot wins), and speaks only for its own socket; `close()` cancels. A dial that
  throws in the timer is reported through `onError` (default `console.error`) and arms the next.
