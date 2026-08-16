// Tier 2: live queries. Registration, per-subscriber authz, snapshot, patch stream.
//
// The rule this file exists to enforce: **policy is evaluated once per subscriber, never once per
// query**. The DB read is shared across subscribers of the same query id; the authz decision is
// not. Two actors on one live query see two different result sets, and a row that fails an actor's
// policy is never sent to that actor — it arrives as a `delete` if they hold it, and is dropped
// otherwise.

import { type Actor, type Clock, systemClock, uuid } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import {
  advance,
  type LiveCursor,
  makeCursor,
  type ReconnectBudget,
  type ResumeSource,
  resumeFrom,
} from './cursor';
import {
  isPolicyDenial,
  LiveQueryUnknownError,
  SubscriptionIdTakenError,
  SubscriptionLimitError,
} from './errors';
import type { JsonValue, Row, RowPatch } from './json';
import {
  type LiveQueryDefinition,
  type LiveSubscription,
  qidOf,
  type SnapshotResult,
} from './live-contract';
import { applyToWindow, bridgeChange } from './matcher-bridge';
import { createEntry, fillWindow, type QueryEntry, refillWindowInLane } from './query-window';
import type { SyncSocket } from './socket';
import { type Subscriber, SubscriberGate, type SubscriberGateOptions } from './subscriber-gate';
import { SubscriptionBook, subscriptionKey } from './subscription-book';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

export interface LiveQueryRegistryOptions extends SubscriberGateOptions {
  readonly source: ResumeSource;
  readonly budget?: ReconnectBudget;
  readonly clock?: Clock;
  readonly maxPerSocket?: number;
  readonly maxPerTenant?: number;
  readonly tenantOf?: (actor: Actor | null) => string | null;
  /**
   * Distinct `(query, input)` pairs this node will hold at once. A `qid` derives from
   * client-chosen input, so without a ceiling one socket mints entries — a matcher, a row window,
   * a `WindowLock` and a fanout target each — until the process dies.
   */
  readonly maxEntries?: number;
}

/**
 * Live `(query, input)` pairs one node holds. Reached, the next NEW pair is refused with
 * `X_SUBSCRIPTION_LIMIT`; subscribing to a pair that already exists keeps working, because the
 * cost this bounds is the entry, not the subscriber.
 */
export const DEFAULT_MAX_ENTRIES = 10_000;

export class LiveQueryRegistry {
  readonly #definitions = new Map<string, LiveQueryDefinition>();
  readonly #entries = new Map<string, QueryEntry>();
  /** Keyed by `(socket, sid)`, never by `sid` alone — `subscription-book.ts` owns why. */
  readonly #book: SubscriptionBook;
  readonly #options: LiveQueryRegistryOptions;
  readonly #clock: Clock;
  readonly #gate: SubscriberGate;
  readonly #maxEntries: number;
  #staleChanges = 0;

  constructor(options: LiveQueryRegistryOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#gate = new SubscriberGate(options);
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    // The book owns the caps because it is the only thing that can answer them in O(1).
    this.#book = new SubscriptionBook(options);
  }

  /** `live.rows_denied` for this node: rows a subscriber's policy refused since boot. */
  get rowsDenied(): number {
    return this.#gate.rowsDenied;
  }

  /** `live.gate_failed` for this node: gates that raised instead of deciding. Never a denial. */
  get gateFailures(): number {
    return this.#gate.gateFailures;
  }

  /** `live.changes_stale`: changes at or below a window's own lsn, refused rather than folded. */
  get staleChanges(): number {
    return this.#staleChanges;
  }

  /**
   * Every window on this node is presumed to have missed a change, so nothing may be patched or
   * served out of one until it has been re-read, and every subscriber is re-snapshotted.
   *
   * The `sync` node calls this when the change stream skips a sequence: over core NATS a fanout is
   * at-most-once, and a node that missed eleven changes during a reconnect otherwise holds a window
   * whose lsn never moved, subscribers whose cursors never moved, and therefore nothing that would
   * ever ask for a re-snapshot. The repair lands on the next change to each query — which is the
   * event that proves the query is moving at all.
   */
  invalidate(): number {
    let marked = 0;
    for (const entry of this.#entries.values()) {
      entry.stale = true;
      for (const subscription of entry.subscribers.values()) {
        subscription.socket.markDesynced(subscription.sid);
        marked += 1;
      }
    }
    return marked;
  }

  register(definition: LiveQueryDefinition): this {
    this.#definitions.set(definition.name, definition);
    return this;
  }

  definition(name: string): LiveQueryDefinition | undefined {
    return this.#definitions.get(name);
  }

  subscriberCount(qid: string): number {
    return this.#entries.get(qid)?.subscribers.size ?? 0;
  }

  /** One socket's subscription. A sid alone does not identify one — see `subscription-book.ts`. */
  subscription(socketId: string, sid: string): LiveSubscription | undefined {
    return this.#book.get(socketId, sid);
  }

  /**
   * Subscribe or resume. Returns the frame this subscriber needs: a `snapshot` on a cold start or a
   * blown reconnect budget, a `patch` when the cursor is inside the retained window.
   */
  async subscribe(args: {
    socket: SyncSocket;
    name: string;
    input: JsonValue;
    sid?: string;
    cursor?: LiveCursor | null;
  }): Promise<{ subscription: LiveSubscription; frame: Frame }> {
    const definition = this.#definitions.get(args.name);
    // A name this node never registered, and not a protocol skew: the frame parsed, the version
    // matched, and one string in it names nothing. Reporting it as `X_PROTOCOL_VERSION` handed the
    // client "x build && redeploy the client" for a typo no rebuild changes.
    if (!definition) throw new LiveQueryUnknownError({ name: args.name });
    this.#book.assertCapacity(args.socket);
    await definition.authorize?.({ actor: args.socket.actor, input: args.input });
    // After this subscriber's own decision, never before it: resolving a shape for a caller who
    // may not subscribe is work an unauthorized client gets to schedule.
    await definition.prepare?.(args.input);

    const qid = qidOf(args.name, args.input);
    const sid = args.sid ?? uuid();
    // Before the entry is built: a sid this socket already holds would overwrite that
    // subscription's slot and strand it inside its query entry, where nothing could reach it
    // again. The client picked the id, so the client is the one told to pick another.
    if (this.#book.has(args.socket.id, sid)) {
      throw new SubscriptionIdTakenError({ sid, socketId: args.socket.id });
    }
    const entry = this.#entryFor(qid, definition, args.input);
    const now = this.#clock.now().getTime();

    if (args.cursor) {
      const resumed = await resumeFrom(args.cursor, {
        source: this.#options.source,
        ...(this.#options.budget ? { budget: this.#options.budget } : {}),
        clock: this.#clock,
        snapshot: async () => await this.#read(entry, { sid, actor: args.socket.actor }),
      });
      if (resumed.kind === 'delta') {
        // The gate decides about whole rows out of the shared window, and an entry nothing has read
        // yet has none — every patch would meet an empty window and be withheld. Filling is
        // conditional on purpose: a restart storm resumes onto entries that already hold a live
        // window, and re-reading per resuming subscriber is the cost a delta resume exists to skip.
        if (entry.lsn === '') await fillWindow(entry);
        // The live entry on purpose: a resume runs outside the lane, so the window under it may
        // have moved on — always forwards, and a row whose grant was revoked in the meantime is
        // one this pass must refuse rather than replay from the state it had at the cursor's lsn.
        const patches = await this.#gate.filterPatches(
          entry,
          { sid, actor: args.socket.actor },
          resumed.patches,
          new Set(args.cursor.ids),
        );
        const subscription = this.#attach(entry, args.socket, sid, resumed.cursor);
        return {
          subscription,
          frame: { type: 'patch', v: PROTOCOL_VERSION, sid, patches, lsn: resumed.cursor.lsn },
        };
      }
      const subscription = this.#attach(entry, args.socket, sid, resumed.cursor);
      return {
        subscription,
        frame: snapshotFrame(entry, sid, resumed.rows, resumed.cursor),
      };
    }

    const fresh = await this.#read(entry, { sid, actor: args.socket.actor });
    const cursor = makeCursor(qid, fresh.lsn, fresh.rows, now);
    const subscription = this.#attach(entry, args.socket, sid, cursor);
    return { subscription, frame: snapshotFrame(entry, sid, fresh.rows, cursor) };
  }

  /** Scoped to the socket that asked: a client may only drop its own subscription. */
  unsubscribe(socketId: string, sid: string): void {
    const subscription = this.#book.get(socketId, sid);
    if (!subscription) return;
    this.#book.delete(socketId, sid);
    subscription.socket.queries.delete(sid);
    subscription.socket.clearDesynced(sid);
    const entry = this.#entries.get(subscription.qid);
    if (!entry) return;
    entry.subscribers.delete(subscriptionKey(socketId, sid));
    // An entry with no subscribers stops costing a matcher and a change window.
    if (entry.subscribers.size !== 0) return;
    this.#entries.delete(subscription.qid);
    // And the retained patches go with it. `forget` had no caller: the entry was dropped here and
    // the `ResumeSource` was never told, so its ring for that qid sat at full capacity until the
    // LRU happened to evict it — a client-chosen input's memory outliving the last subscriber.
    this.#options.source.forget?.(subscription.qid);
  }

  unsubscribeSocket(socketId: string): void {
    for (const subscription of this.#book.ofSocket(socketId)) {
      this.unsubscribe(socketId, subscription.sid);
    }
  }

  /**
   * Actor changed mid-connection (login, logout, role change): re-run subscribe-time authz and drop
   * what is no longer allowed. Survivors are marked desynced so the next flush re-snapshots them
   * under the new actor's row policy. Returns the sids that were dropped — a denial and nothing
   * else, so a caller may tell the client "you may no longer see this" and be right.
   */
  async reauthorize(socket: SyncSocket): Promise<readonly string[]> {
    const dropped: string[] = [];
    // The actor changed, so what tenant this socket's subscriptions count against may have too.
    // Told here rather than derived per lookup: the per-tenant cap is an index now, and an index
    // nobody updates is a count that drifts from the book for the rest of the process.
    this.#book.retenant(socket);
    for (const subscription of this.#book.ofSocket(socket.id)) {
      try {
        await subscription.definition.authorize?.({
          actor: socket.actor,
          input: subscription.input,
        });
      } catch (error) {
        if (isPolicyDenial(error)) {
          this.unsubscribe(socket.id, subscription.sid);
          dropped.push(subscription.sid);
          continue;
        }
        // Not a decision — the gate never reached one. Destroying the subscription would report a
        // database timeout as a revoked grant, and a client does not resubscribe to a denial. It
        // survives, desynced: nothing is delivered from the window built under the old actor, and
        // the row gate still decides every row under the new one, from the same policy `authorize`
        // consults. The failure is counted and reported rather than silently absorbed.
        this.#gate.failedAuthorize(
          subscription.qid,
          { sid: subscription.sid, actor: socket.actor },
          error,
        );
      }
      socket.markDesynced(subscription.sid);
    }
    return dropped;
  }

  /**
   * Fan one change out. Matched once per query id, authorized once per subscriber. Returns the
   * number of frames sent — the metric the reconnect benchmark watches.
   *
   * Each entry's turn is taken in that entry's lane. Nothing upstream orders this: `sync` fires
   * `void registry.deliver(change)` straight off the bus subscription, so two changes arriving back
   * to back would otherwise interleave inside one query id — lsn 2 delivered before lsn 1, the
   * subscriber's cursor rewound to 1, and every gate deciding against whichever window won.
   *
   * Every lane is *entered* before any of them is awaited, and nothing inside a fanout takes a
   * second lane, so holding all of them at once cannot be a cycle. That is what makes the ordering
   * claim true: two deliveries queue onto each query id in call order, serialized per query id and
   * never per node — awaiting one entry before entering the next made one slow policy pass the
   * whole node's pace, and let a lane that threw skip every entry behind it with nobody desynced.
   */
  async deliver(change: ChangeEvent): Promise<number> {
    const lanes = [...this.#entries.values()].map(async (entry) => {
      try {
        return await entry.lock.run(() => this.#fanout(entry, change));
      } catch (error) {
        // The window advanced under a fanout that did not finish, so every subscriber of this one
        // query id now holds a cursor below the change and no later flush would correct them:
        // desynced here, re-snapshotted on the next one. Silent divergence is the whole reason
        // `markDesynced` exists, and skipping this is how a failure became one.
        for (const subscription of entry.subscribers.values()) {
          subscription.socket.markDesynced(subscription.sid);
        }
        throw error;
      }
    });
    // `allSettled`, so one lane's rejection neither cancels the others nor goes unhandled. The
    // first failure still reaches the caller — `sync` logs it — but it costs one query id.
    let sent = 0;
    let failure: { readonly error: unknown } | null = null;
    for (const lane of await Promise.allSettled(lanes)) {
      if (lane.status === 'fulfilled') sent += lane.value;
      else failure ??= { error: lane.reason };
    }
    if (failure !== null) throw failure.error;
    return sent;
  }

  /**
   * One change, one query id, inside that entry's lane — so the window this mutates at the top is
   * still the window every subscriber's gate reads at the bottom, and the patches reach the
   * retained buffer in the order the client will be asked to fold them.
   */
  async #fanout(entry: QueryEntry, change: ChangeEvent): Promise<number> {
    // A window that missed a change must be replaced before it is patched again, and it can only be
    // replaced here — a fanout holds this entry's lane, and `fillWindow` takes the same one.
    if (entry.stale) await refillWindowInLane(entry);
    // The consume-side twin of the replicator's own duplicate guard, which had none. `entry.lsn =
    // change.lsn` was unconditional, so a change the window already holds — a redelivery, or one
    // that arrived behind the snapshot that already included it — rewound every subscriber's cursor
    // to it and asked them to fold state they had already folded over newer rows.
    if (entry.lsn !== '' && change.lsn <= entry.lsn) {
      this.#staleChanges += 1;
      return 0;
    }
    const result = bridgeChange(entry.shape, entry.matcher, change, entry.rows);
    if (!result) return 0;
    entry.lsn = change.lsn;
    entry.rows = applyToWindow(entry.rows, result.patches);
    // The window lost its tail, so what it holds is a guess — the next delivery re-reads it rather
    // than patching a guess, and every subscriber below is re-snapshotted out of what that returns.
    if (result.refill) entry.stale = true;
    // The retained window holds the pre-policy patch; resume re-filters it per subscriber.
    for (const patch of result.patches) this.#options.source.append(entry.qid, patch);

    let sent = 0;
    for (const subscription of entry.subscribers.values()) {
      // `desynced` had four writers and no reader: a subscriber whose patch was dropped by
      // backpressure, whose gate failed, or whose window lost its tail was recorded as diverged and
      // then served the next patch as if nothing had happened — permanently and silently stale on a
      // healthy socket. A marked subscriber is re-snapshotted out of the shared window instead, at
      // the cost of one frame and no DB read, and only then is the mark cleared.
      if (subscription.socket.desynced.has(subscription.sid)) {
        if (await this.#resnapshot(entry, subscription)) sent += 1;
        continue;
      }
      if (result.refill) {
        // The window lost its tail: guessing is how a sync engine silently diverges.
        subscription.socket.markDesynced(subscription.sid);
        continue;
      }
      const who: Subscriber = { sid: subscription.sid, actor: subscription.socket.actor };
      let allowed: readonly RowPatch[];
      try {
        allowed = await this.#gate.filterPatches(
          entry,
          who,
          result.patches,
          new Set(subscription.cursor.ids),
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
      const frame: Frame = {
        type: 'patch',
        v: PROTOCOL_VERSION,
        sid: subscription.sid,
        patches: allowed,
        lsn: change.lsn,
      };
      if (subscription.socket.send(frame)) {
        subscription.cursor = advance(subscription.cursor, allowed, change.lsn, change.at);
        sent += 1;
      } else {
        subscription.socket.markDesynced(subscription.sid);
      }
    }
    return sent;
  }

  /**
   * The repair for one diverged subscriber, out of the window the lane is already holding — no DB
   * read, one frame. Its cursor is rebuilt from what this subscriber may actually see, exactly as
   * `subscribe` does, because a cursor over the pre-policy window would claim ids the client was
   * never sent. The mark is cleared only on a frame that left: a send refused by backpressure keeps
   * the subscriber diverged, which is the state it is actually in.
   */
  async #resnapshot(entry: QueryEntry, subscription: LiveSubscription): Promise<boolean> {
    const who: Subscriber = { sid: subscription.sid, actor: subscription.socket.actor };
    let rows: readonly Row[];
    try {
      rows = await this.#gate.filterRows(entry, who, entry.rows);
    } catch {
      // Counted and reported as a gate failure already. It stays desynced: a subscriber whose rule
      // cannot decide is not one to serve rows to, and the next change tries again.
      return false;
    }
    const cursor = makeCursor(entry.qid, entry.lsn, rows, this.#clock.now().getTime());
    if (!subscription.socket.send(snapshotFrame(entry, subscription.sid, rows, cursor))) {
      return false;
    }
    subscription.cursor = cursor;
    subscription.socket.clearDesynced(subscription.sid);
    return true;
  }

  #attach(
    entry: QueryEntry,
    socket: SyncSocket,
    sid: string,
    cursor: LiveCursor,
  ): LiveSubscription {
    const subscription: LiveSubscription = {
      sid,
      qid: entry.qid,
      socket,
      input: entry.input,
      definition: entry.definition,
      cursor,
    };
    // The entry's own map takes the SAME composite key: a sid alone would collide across sockets
    // here exactly as it did in the book, and `unsubscribe` deletes from both by one identity.
    entry.subscribers.set(subscriptionKey(socket.id, sid), subscription);
    this.#book.add(subscription);
    socket.queries.set(sid, entry.qid);
    socket.clearDesynced(sid);
    return subscription;
  }

  #entryFor(qid: string, definition: LiveQueryDefinition, input: JsonValue): QueryEntry {
    const existing = this.#entries.get(qid);
    if (existing) return existing;
    // The node-wide ceiling, refused where the entry would be born. `qid` derives from
    // client-chosen input, so one socket varying it mints a matcher, a row window and a
    // `WindowLock` per value, and every change then fans out over all of them.
    if (this.#entries.size >= this.#maxEntries) {
      throw new SubscriptionLimitError({
        scope: 'node',
        id: definition.name,
        limit: this.#maxEntries,
        knob: 'maxEntries',
      });
    }
    const created = createEntry(qid, definition, input, definition.matcher(input));
    this.#entries.set(qid, created);
    return created;
  }

  /**
   * One read, then one policy pass per subscriber. Never one read per subscriber — and never a
   * partial pass: a gate that fails raises out of `subscribe`, because a snapshot missing the rows
   * nobody could decide about is a short result set this subscriber would render as the whole one.
   */
  async #read(entry: QueryEntry, who: Subscriber): Promise<SnapshotResult> {
    const window = await fillWindow(entry);
    return { rows: await this.#gate.filterRows(entry, who, window.rows), lsn: window.lsn };
  }
}

/** The one place a snapshot frame is built, so the identity scope cannot be told to one caller only. */
function snapshotFrame(
  entry: QueryEntry,
  sid: string,
  rows: readonly Row[],
  cursor: LiveCursor,
): Frame {
  const base = { type: 'snapshot', v: PROTOCOL_VERSION, sid, rows, cursor } as const;
  return entry.rowEntity === null ? base : { ...base, entity: entry.rowEntity };
}
