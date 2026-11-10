# realtime: rule text moved out of `packages/realtime/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file to make room under its 24,576 B ceiling
(`bun run scripts/claude-md-size.ts`). Each section below is a bullet as it stood, verbatim; the
package file keeps a one-line rule marked `†`. Where the two disagree, `packages/realtime/CLAUDE.md`
wins. Older long forms: [`realtime.md`](realtime.md), [`realtime-agent-notes.md`](realtime-agent-notes.md).

## A denial is a decision

- **A denial is a decision; everything else is a failure.** `visibleWithPolicy` matches
  `QueryDeniedError` and rethrows the rest; `subscriber-gate.ts` and `reauthorize` ask
  `isPolicyDenial(error)`. A failed snapshot raises out of `subscribe`; a failed delivery desyncs that
  one subscriber; a failed `reauthorize` keeps the subscription, a DENIED one is refused under its sid
  (`refuseSubscription`) — as is one whose org moved, and a failed re-seat. Failures count as
  `gateFailures` via `onGateFailed`, never `onRowDenied`.

## One serial lane per query id

- **One serial lane per query id (`WindowLock`) is the only thing that orders a fanout.** `deliver`
  enters every lane before awaiting any; no fanout takes a second lane; a lane that fails desyncs its
  own subscribers; lanes chain on a settled shadow of each task. **A change enters only
  `LiveEntries.targets(table)`** (its table's readers + stale/unread windows; `live-deliver.test.ts`);
  a lane at `maxLaneDepth` (1,024) SHEDS it: window staled, `changesShed` counted.

## A window is per tenant

- **A WINDOW is per TENANT**: `windowId(queryHash(name, input), tenant)` (`live-tenant.ts`; tenant =
  the subscriber's `actor.orgId`). The read runs `readFor` (`live-definition.ts`): the node's ctx, a
  service actor carrying ONLY that org — never the subscriber. A cursor naming another window is a cold start; `reauthorize` re-seats a
  subscription whose actor changed org (`live-tenancy.test.ts`; `docs/history/realtime.md`).

## One socket per origin and principal

- **One socket per ORIGIN and principal, in a SharedWorker**: `socket-engine.ts` holds it and talks
  to tabs over `MessagePort`s (`socket-host.ts`'s virtual socket); wants are ref-counted and frames
  routed; a port silent for `REAP_AFTER_BEATS` is reaped; each tab resubscribes from its OWN cursors.
  No `SharedWorker` → the in-page host runs the same engine over a `MessageChannel`.
