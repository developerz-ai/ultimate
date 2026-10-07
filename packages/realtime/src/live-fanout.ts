// One change, one query id, inside that query's lane: match it, fold it into the shared window,
// then one policy pass per subscriber over what came out. Split from `live-query.ts` because the
// registry owns the lanes and the entry table while this owns what happens inside one of them —
// and because one file runs one job. The lane itself is never taken here: the caller is holding it.

import { type Clock, isWriteDigest } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { advance, type LiveCursor, makeCursor, type ResumeSource } from './cursor';
import type { Row, RowPatch } from './json';
import type { LiveSubscription } from './live-contract';
import { applyToWindow, bridgeChange, type Projection, projectionOf } from './matcher-bridge';
import { type QueryEntry, refillWindowInLane } from './query-window';
import { type Subscriber, type SubscriberGate, windowIndex } from './subscriber-gate';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';
import { FRAME_LIMITS } from './wire-version';

export interface FanoutDeps {
  readonly gate: SubscriberGate;
  readonly source: ResumeSource;
  readonly clock: Clock;
}

export interface FanoutResult {
  /** Frames that left this node for this query id. */
  readonly sent: number;
  /** `1` when the change was at or below the window's own lsn — `live.changes_stale`. */
  readonly stale: number;
}

/**
 * The fanout for one entry, run inside that entry's lane — so the window this mutates at the top is
 * still the window every subscriber's gate reads at the bottom, and the patches reach the retained
 * buffer in the order the client will be asked to fold them.
 */
export async function fanoutChange(
  deps: FanoutDeps,
  entry: QueryEntry,
  change: ChangeEvent,
): Promise<FanoutResult> {
  // A window that missed a change must be replaced before it is patched again, and it can only be
  // replaced here — a fanout holds this entry's lane, and `fillWindow` takes the same one.
  // No read has landed in this window yet: there is nothing to patch, and a patch folded into the
  // empty rows would move `entry.lsn` past the read in flight and get that read discarded as older
  // than the window — every row but the patched one lost, permanently. Marked stale instead, so the
  // read that lands is applied and followed by one that includes this change.
  if (entry.applied === 0) {
    entry.stale = true;
    return { sent: 0, stale: 0 };
  }
  if (change.op === 'truncate') return await truncated(deps, entry, change);
  // Screened, not trusted: a frame carrying anything but a digest is refused WHOLE by the decoder,
  // so a malformed label would cost every subscriber this change rather than one page its echo.
  const write = isWriteDigest(change.write) ? change.write : null;
  const writes = write === null ? [] : [write];
  // What a re-snapshot out of rows that hold this change may name: the write, by the row it made.
  const named = namedBy(entry, change, write);
  const reread = entry.stale;
  if (reread) {
    await refillWindowInLane(entry);
    // What was retained before this read has a hole exactly where the staleness came from.
    deps.source.floorAt?.(entry.qid, entry.lsn, { exclusive: true });
    // Every subscriber was fed from the rows this read just replaced, so each is owed a snapshot —
    // not only the ones `invalidate()` marked: a read that failed or timed out stales the window
    // and marks nobody.
    for (const subscription of entry.subscribers.values()) {
      subscription.socket.markDesynced(subscription.sid);
    }
    // The read claims to hold this change already (`lsn` is the node's newest when it began), so
    // there is nothing to patch. Returning before the loop below was the defect: the guard after
    // this refused the change as stale and every desynced subscriber went without the change AND
    // without its snapshot — a run console frozen on its first event after one `updateWhere`.
    if (change.lsn <= entry.lsn) return { sent: await resnapshotAll(deps, entry, named), stale: 0 };
  }
  // The consume-side twin of the replicator's own duplicate guard, which had none. `entry.lsn =
  // change.lsn` was unconditional, so a change the window already holds — a redelivery, or one
  // that arrived behind the snapshot that already included it — rewound every subscriber's cursor
  // to it and asked them to fold state they had already folded over newer rows.
  if (entry.lsn !== '' && change.lsn <= entry.lsn) return { sent: 0, stale: 1 };
  const bridged = bridgeChange(entry.shape, entry.matcher, change, entry.rows);
  // Matching nothing ends the fanout, but never before a re-read's marks are answered. Named
  // nothing: that read began before this change, so it is not truth that holds its write.
  if (!bridged) return { sent: reread ? await resnapshotAll(deps, entry) : 0, stale: 0 };
  // Keyed ONCE, here, before the retained window stores them: a resume replays the same key.
  const result = { ...bridged, patches: keyPatches(entry, change, bridged.patches) };
  // Asked of the window as it stood BEFORE this change: the partial row must not teach it a shape.
  const partial = lacksOmitted(change, result.patches, projectionOf(entry.rows));
  entry.lsn = change.lsn;
  entry.rows = applyToWindow(entry.rows, result.patches);
  // The window lost its tail — or adopted a row the change could not carry whole — so what it
  // holds is a guess: the next delivery re-reads it rather than patching a guess, and every
  // subscriber below is re-snapshotted out of what that returns.
  const guessed = result.refill || partial;
  if (guessed) entry.stale = true;
  // The retained window holds the pre-policy patch; resume re-filters it per subscriber. A partial
  // row is never retained: replayed, it is the same missing column on a resuming client. Each
  // retained patch keeps the write that made it, so a delta resume can name it too.
  if (!partial)
    for (const patch of result.patches) deps.source.append(entry.qid, retain(patch, write));
  // And the ring says so now, not at the re-read: a resume in between got a delta lacking it.
  else deps.source.floorAt?.(entry.qid, change.lsn, { exclusive: true });

  let sent = 0;
  // Indexed once for every subscriber below, never searched per subscriber per patch.
  const index = windowIndex(entry.rows);
  for (const subscription of entry.subscribers.values()) {
    if (guessed) {
      // The window lost its tail: guessing is how a sync engine silently diverges. Checked BEFORE
      // the mark, because a repair reads `entry.rows` — which this fanout has just declared a
      // guess — and then CLEARS the mark. A subscriber already diverged would be recorded as
      // repaired against rows nothing trusts, and the next change, having refilled the window,
      // sends it a patch instead of the snapshot it is still owed. A lost tail degrades every
      // subscriber the same way, whatever each was holding.
      subscription.socket.markDesynced(subscription.sid);
      continue;
    }
    // `desynced` had four writers and no reader: a subscriber whose patch was dropped by
    // backpressure, whose gate failed, or whose window lost its tail was recorded as diverged and
    // then served the next patch as if nothing had happened — permanently and silently stale on a
    // healthy socket. A marked subscriber is re-snapshotted out of the shared window instead, at
    // the cost of one frame and no DB read, and only then is the mark cleared.
    if (subscription.socket.desynced.has(subscription.sid)) {
      // Out of the window this change was just folded into, so it holds the change's write.
      if (await resnapshot(deps, entry, subscription, named)) sent += 1;
      continue;
    }
    const who: Subscriber = { sid: subscription.sid, actor: subscription.socket.actor };
    let allowed: readonly RowPatch[];
    try {
      allowed = await deps.gate.filterPatches(
        entry,
        who,
        result.patches,
        heldBy(subscription.cursor),
        index,
      );
    } catch {
      // Already counted and reported as a gate failure. Degrade this one subscriber the way a
      // lost window tail degrades them — desynced, re-snapshotted on the next flush — because
      // rejecting here would abandon the fanout to every other subscriber over one actor's
      // broken rule, and delivering the patches anyway would be the leak.
      subscription.socket.markDesynced(subscription.sid);
      continue;
    }
    if (allowed.length === 0) continue;
    const frame = patchFrame(subscription.sid, allowed, change.lsn, writes);
    if (subscription.socket.send(frame)) {
      subscription.cursor = advance(subscription.cursor, allowed, change.lsn, change.at);
      sent += 1;
    } else {
      subscription.socket.markDesynced(subscription.sid);
    }
  }
  return { sent, stale: 0 };
}

/**
 * Whether a row ENTERS the window without a column the change did not carry
 * (`ChangeEvent.omitted`: an unchanged out-of-line value Postgres logged no bytes for). An update
 * patch is safe — it merges onto a window row that already holds the column — but an add adopts
 * the row as the whole row, into the window, every later snapshot and the retained ring. An
 * unread projection (an empty window) cannot rule a column out, so every omitted one counts.
 */
function lacksOmitted(
  change: ChangeEvent,
  patches: readonly RowPatch[],
  projection: Projection,
): boolean {
  const omitted = change.omitted;
  if (omitted === undefined || omitted.length === 0) return false;
  return patches.some(
    (patch) =>
      patch.op === 'insert' &&
      patch.row !== null &&
      omitted.some(
        (column) =>
          (projection === undefined || projection.has(column)) &&
          !Object.hasOwn(patch.row ?? {}, column),
      ),
  );
}

/**
 * Every row of a relation this window reads is gone. There is nothing to patch from — a truncate
 * names no row — so the window is re-read now, in the lane, and every subscriber is re-snapshotted
 * out of what came back: a window that kept the truncated rows until its next change would serve
 * them to every new subscriber in the meantime.
 */
async function truncated(
  deps: FanoutDeps,
  entry: QueryEntry,
  change: ChangeEvent,
): Promise<FanoutResult> {
  if (!entry.shape.entities.includes(change.table)) return { sent: 0, stale: 0 };
  await refillWindowInLane(entry);
  if (change.lsn > entry.lsn) entry.lsn = change.lsn;
  deps.source.floorAt?.(entry.qid, entry.lsn, { exclusive: true });
  for (const subscription of entry.subscribers.values()) {
    subscription.socket.markDesynced(subscription.sid);
  }
  return { sent: await resnapshotAll(deps, entry), stale: 0 };
}

/** Each marked subscriber, re-snapshotted out of the window just read. Frames that left. */
async function resnapshotAll(
  deps: FanoutDeps,
  entry: QueryEntry,
  named: readonly NamedWrite[] = [],
): Promise<number> {
  let sent = 0;
  for (const subscription of entry.subscribers.values()) {
    if (!subscription.socket.desynced.has(subscription.sid)) continue;
    if (await resnapshot(deps, entry, subscription, named)) sent += 1;
  }
  return sent;
}

/**
 * A cursor's ids as a set, built once per ids ARRAY rather than once per subscriber per change.
 * `advance` hands an update's cursor the same array it had (an update moves no id), so the cache
 * holds across the common change and dies with the array; an insert or delete makes a new one.
 */
const heldSets = new WeakMap<readonly string[], ReadonlySet<string>>();

function heldBy(cursor: LiveCursor): ReadonlySet<string> {
  const cached = heldSets.get(cursor.ids);
  if (cached !== undefined) return cached;
  const held = new Set(cursor.ids);
  heldSets.set(cursor.ids, held);
  return held;
}

/**
 * The repair for one diverged subscriber, out of the window the lane is already holding — no DB
 * read, one frame. Its cursor is rebuilt from what this subscriber may actually see, exactly as
 * `subscribe` does, because a cursor over the pre-policy window would claim ids the client was
 * never sent. The mark is cleared only on a frame that left: a send refused by backpressure keeps
 * the subscriber diverged, which is the state it is actually in.
 */
async function resnapshot(
  deps: FanoutDeps,
  entry: QueryEntry,
  subscription: LiveSubscription,
  named: readonly NamedWrite[],
): Promise<boolean> {
  const who: Subscriber = { sid: subscription.sid, actor: subscription.socket.actor };
  let rows: readonly Row[];
  try {
    rows = await deps.gate.filterRows(entry, who, entry.rows);
  } catch {
    // Counted and reported as a gate failure already. It stays desynced: a subscriber whose rule
    // cannot decide is not one to serve rows to, and the next change tries again.
    return false;
  }
  const cursor = makeCursor(entry.qid, entry.lsn, rows, deps.clock.now().getTime());
  const frame = snapshotFrame(entry, subscription.sid, rows, cursor, named);
  if (!subscription.socket.send(frame)) return false;
  subscription.cursor = cursor;
  subscription.socket.clearDesynced(subscription.sid);
  return true;
}

/** A write this truth may hold, and the RECORD key of the row it made — what it is shown by. */
export interface NamedWrite {
  readonly write: string;
  readonly key: string;
}

/**
 * The one place a snapshot frame is built, so the identity scope, the record keys and the writes
 * cannot be told to one caller only. `keys` rides only when some key differs from its row's `id`
 * — an entity keyed by `id` sends the frame it always sent. A write in `named` is sent only when
 * the row it made is among `rows`, which are already filtered for THIS subscriber: a write behind
 * a row it may not see is another actor's, never named to it.
 */
export function snapshotFrame(
  entry: QueryEntry,
  sid: string,
  rows: readonly Row[],
  cursor: LiveCursor,
  named: readonly NamedWrite[] = [],
): Frame {
  const keyOf = entry.rowKey;
  const keys = rows.map((row) => (keyOf === null ? row.id : keyOf(row)));
  const shown = new Set(keys);
  const writes = new Set<string>();
  for (const { write, key } of named) if (shown.has(key)) writes.add(write);
  const base = { type: 'snapshot', v: PROTOCOL_VERSION, sid, rows, cursor } as const;
  // Capped where the decoder caps it: a frame over the ceiling is refused whole, and a write left
  // unnamed only settles on its own HTTP answer.
  const listed = [...writes].slice(0, FRAME_LIMITS.patches);
  const withWrites = listed.length === 0 ? base : { ...base, writes: listed };
  const scoped = entry.rowEntity === null ? withWrites : { ...withWrites, entity: entry.rowEntity };
  return keys.every((key, index) => key === rows[index]?.id) ? scoped : { ...scoped, keys };
}

/** The change's write, by the record key of the row it made; nothing for an unkeyed change. */
function namedBy(
  entry: QueryEntry,
  change: ChangeEvent,
  write: string | null,
): readonly NamedWrite[] {
  const whole = change.after ?? change.before;
  if (write === null || whole === null) return [];
  return [{ write, key: entry.rowKey === null ? whole.id : entry.rowKey(whole) }];
}

/**
 * A patch's record key, from the change's WHOLE row — an update patch carries only the changed
 * columns, and a key needs every primary-key column. Only stamped where it differs from `id`.
 */
function keyPatches(
  entry: QueryEntry,
  change: ChangeEvent,
  patches: readonly RowPatch[],
): readonly RowPatch[] {
  const keyOf = entry.rowKey;
  const whole = change.after ?? change.before;
  if (keyOf === null || whole === null) return patches;
  const key = keyOf(whole);
  return patches.map((patch) => (key === patch.id ? patch : { ...patch, key }));
}

/** The patch the ring retains: the pre-policy patch plus the write that made its change. */
function retain(patch: RowPatch, write: string | null): RowPatch {
  return write === null ? patch : { ...patch, write };
}

/**
 * The one place a patch frame is built, so a live fanout and a delta resume cannot spell it two
 * ways. `writes` rides only when some keyed write made a patch here: an unkeyed change sends the
 * frame it always sent.
 */
export function patchFrame(
  sid: string,
  patches: readonly RowPatch[],
  lsn: string,
  writes: readonly string[],
): Frame {
  const base = { type: 'patch', v: PROTOCOL_VERSION, sid, patches, lsn } as const;
  return writes.length === 0 ? base : { ...base, writes };
}
