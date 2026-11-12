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

## A gap is detected

- **A change the window already holds is refused** (`change.lsn <= entry.lsn`, counted as
  `staleChanges`). **A gap is detected**: the replicator stamps `producer` + `seq`; a skipped
  sequence — or a NEW producer after a known one — stales every window; `refillWindowInLane` replaces it.
  Unless the new run's first envelope says `from` (v2) at or below the highest lsn the node read:
  that run republishes everything above it, so it chains (`SeqGapDetector.#chain`). A clean
  `stop()` hands over (`replicator-handover.ts`): the chain rises to the slot's confirmed position,
  which is the `from` a NEW process's run claims (`slotConfirmed`, read after the slot is released).
  A claim a feed cannot keep is a silent loss: `onResume` only when it KNOWS.

## stop() reads the goodbye

- **`stop()` reads the walsender's goodbye before `Terminate`** (`pg-replication-goodbye.ts`):
  CopyDone → its CopyDone, CommandComplete, ReadyForQuery, bounded at `COPY_DRAIN_MS`. Closed
  unread, the socket was reset — `Connection reset by peer` in the server log on every deploy.

## A slot is asked its wal_status

- **A slot is asked its `wal_status`**: `lost` is `X_REPLICATION_SLOT_INVALIDATED`; one created under
  a resume is `X_REPLICATION_SLOT_RECREATED`, drops `from`, and owes `x.change.-resync` (a node
  answers it as a reconnect) till published.

## A slot still held is waited for

- **A slot still held is waited for before START_REPLICATION** (`pg-slot-release.ts`): a walsender
  frees it AFTER the goodbye, so preflight reads `active_pid` and polls on the server's clock, ~5 s
  bound, then lets 55006 refuse (`pg-slot-release.test.ts`, the held-slot live test).

## The pump has one way out

- **The pump has one way out, `#die`**: failure, timer, connection, then `onEnd`. **A walsender
  that stops answering is dead** — 3 intervals read-silent, or a confirm unsettled
  (`pg-replication-liveness.ts`): destroyed, no goodbye. A run is fenced by its connection.

## A stream that ends is restarted

- **A stream that ENDS, or a LOST lock, is restarted** from `lastLsn` on `retryDelayMs`; a lost
  connection (`connectionLost`) redials at once, then ≤ 2 s (`replicator-reconnect.ts`); feed then
  lock ABANDONED; `running` = pumping and no refused change owed (history, 2026-11-09).

## The grant is recorded before the upgrade

- **The grant is recorded BEFORE `server.upgrade`** (Bun runs `open` synchronously inside it) and
  released on every path that never opens — `onUngranted` is REQUIRED on `UpgradeDeps`, and a
  `server.upgrade` that THROWS releases too. `sync-node-auth.test.ts`'s harness opens inside
  `upgrade()`, as Bun does.

## A bulk write stales only its entity

- **A bulk write stales only its entity's readers**: windows + channel topics, `invalidate(entity)`
  on both from `onBulk` (channels: not a `recordPublisher` table). **A stale window's re-read
  re-snapshots EVERY subscriber**, before the lsn guard, even on a non-match (`live-replicator-bulk`,
  `live-fanout` tests).
