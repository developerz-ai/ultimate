// Tier 2: live queries. Registration, per-subscriber authz, snapshot, patch stream.
//
// The rule this file exists to enforce: **policy is evaluated once per subscriber, never once per
// query**. The DB read is shared across subscribers of the same query id IN ONE TENANT
// (`live-tenant.ts`); the authz decision is not shared at all. Two actors on one live query see two different result sets, and a row that fails an actor's
// policy is never sent to that actor — it arrives as a `delete` if they hold it, and is dropped
// otherwise.

import { type Clock, finiteOption, systemClock, uuid } from '@ultimat3/core';
import { queryHash } from '@ultimat3/query';
import type { ChangeEvent } from './changefeed';
import { type LiveCursor, makeCursor } from './cursor';
import { LiveQueryUnknownError, SubscriptionLimitError } from './errors';
import type { JsonValue } from './json';
import type { LiveQueryDefinition, LiveSubscription, SnapshotResult } from './live-contract';
import { deliverChange } from './live-deliver';
import { type FanoutDeps, snapshotFrame } from './live-fanout';
import { floorAfterRead } from './live-floor';
import { DEFAULT_MAX_ENTRIES, type LiveQueryRegistryOptions } from './live-query-options';
import { reauthorizeSocket } from './live-reauth';
import { resumeOnto } from './live-resume';
import { type Charge, type SubscribeArgs, spendOnce } from './live-spend';
import { liveTenantOf, windowId } from './live-tenant';
import { createEntry, fillWindow, type QueryEntry } from './query-window';
import type { SyncSocket } from './socket';
import { type Subscriber, SubscriberGate } from './subscriber-gate';
import { SubscriptionBook, subscriptionKey } from './subscription-book';
import type { Frame } from './sync-protocol';

export { DEFAULT_MAX_ENTRIES, type LiveQueryRegistryOptions } from './live-query-options';

export class LiveQueryRegistry {
  readonly #definitions = new Map<string, LiveQueryDefinition>();
  readonly #entries = new Map<string, QueryEntry>();
  /** Keyed by `(socket, sid)`, never by `sid` alone — `subscription-book.ts` owns why. */
  readonly #book: SubscriptionBook;
  readonly #options: LiveQueryRegistryOptions;
  readonly #clock: Clock;
  readonly #gate: SubscriberGate;
  readonly #maxEntries: number;
  /** What one lane needs, and nothing this class holds beyond it. */
  readonly #fanout: FanoutDeps;
  #lastLsn = '';
  /**
   * This node's mark for a window read before it held any position: unique to the process, and
   * `!` sorts below every hex digit, so every real change is above it.
   */
  readonly #origin = `!${uuid()}`;
  #staleChanges = 0;

  constructor(options: LiveQueryRegistryOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#gate = new SubscriberGate(options);
    this.#maxEntries = finiteOption(
      'the live-query registry',
      'maxEntries',
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    );
    // The book owns the caps because it is the only thing that can answer them in O(1).
    this.#book = new SubscriptionBook(options);
    this.#fanout = { gate: this.#gate, source: options.source, clock: this.#clock };
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
   *
   * `entity` narrows it to the windows that read that entity: a filtered write
   * (`updateWhere`/`deleteWhere`) names its entity but no row, and staling every window on the node
   * for it re-read every live query in the process on each bulk write to any table.
   */
  invalidate(entity?: string): number {
    let marked = 0;
    for (const entry of this.#entries.values()) {
      if (entity !== undefined && !entry.shape.entities.includes(entity)) continue;
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
  subscribe(args: SubscribeArgs): Promise<{ subscription: LiveSubscription; frame: Frame }> {
    return this.#subscribe(args, { due: true });
  }

  /** `charge.due` false: a re-seat, whose subscription was paid for when it was first made. */
  async #subscribe(
    args: SubscribeArgs,
    charge: Charge,
  ): Promise<{ subscription: LiveSubscription; frame: Frame }> {
    const definition = this.#definitions.get(args.name);
    // A name this node never registered, and not a protocol skew: the frame parsed, the version
    // matched, and one string in it names nothing. Reporting it as `X_PROTOCOL_VERSION` handed the
    // client "x build && redeploy the client" for a typo no rebuild changes.
    if (!definition) throw new LiveQueryUnknownError({ name: args.name });
    const sid = args.sid ?? uuid();
    // Everything this subscribe can be refused for, decided in one synchronous step BEFORE the
    // first await — the caps and the sid both. Read at the top and acted on three awaits later,
    // they were bypassed by the ordinary case: one WebSocket write carrying N subscribe frames,
    // dispatched concurrently, N of them reading a count nothing had grown yet.
    const slot = this.#book.reserve(args.socket, sid);
    try {
      for (;;) {
        // `authorize`, the read and the row pass all await, and a re-auth that lands under them
        // re-decides only what is ATTACHED. So a subscription seated for an actor the socket no
        // longer carries is taken back and served again under the one it does.
        const actor = args.socket.actor;
        const served = await this.#subscribeReserved(definition, sid, args, charge);
        if (args.socket.actor === actor) return served;
        this.unsubscribe(args.socket.id, sid);
      }
    } finally {
      // After the attach on every path, so the slot is only ever given back to a count that has
      // already grown — or, on a failure, to one that never will.
      slot.release();
    }
  }

  async #subscribeReserved(
    definition: LiveQueryDefinition,
    sid: string,
    args: {
      socket: SyncSocket;
      name: string;
      input: JsonValue;
      cursor?: LiveCursor | null;
    },
    charge: Charge,
  ): Promise<{ subscription: LiveSubscription; frame: Frame }> {
    await definition.authorize?.({ actor: args.socket.actor, input: args.input });
    // The window is the subscriber's TENANT's: two orgs on one `(query, input)` are two entries,
    // two reads and two retained rings, so no shared row ever stands between them and a policy.
    const tenant = liveTenantOf(args.socket.actor);
    const qid = windowId(queryHash(args.name, args.input), tenant);
    // After this subscriber's own decision, never before it: resolving a shape for a caller who
    // may not subscribe is work an unauthorized client gets to schedule.
    await definition.prepare?.(args.input);

    const entry = this.#entryFor(qid, definition, args.input, tenant);
    try {
      // Charged where a read happens, never from the cursor's say-so (`live-spend.ts`).
      const pay = () => spendOnce(definition, args.socket, charge, this.#clock);
      return await this.#serve(entry, sid, args, pay);
    } catch (error) {
      // The entry was born above, before anything could fill it. Everything below can throw — the
      // snapshot, the resume, the window's own read deadline — and `unsubscribe` is the only other
      // removal path, reachable only through a subscription that in this case was never attached.
      this.#dropIfUnheld(qid, entry);
      throw error;
    }
  }

  /** The half of a subscribe that runs against a live entry, so its failures can be undone. */
  async #serve(
    entry: QueryEntry,
    sid: string,
    args: {
      socket: SyncSocket;
      name: string;
      input: JsonValue;
      cursor?: LiveCursor | null;
    },
    pay: () => Promise<void>,
  ): Promise<{ subscription: LiveSubscription; frame: Frame }> {
    const qid = entry.qid;
    const now = this.#clock.now().getTime();

    // A cursor is CLIENT data, and its `qid` names the window whose retained patches a resume
    // replays. One that names another window — the same browser, signed in to another org, or a
    // forged frame — is not a position in this one: it is a cold start, never a replay of a ring
    // this subscriber's window does not own.
    //
    // Nor is ANY cursor a position in a window known to have missed a change: the ring still
    // answers a delta for it, and that delta is the hole. A stale entry serves cold starts only.
    if (args.cursor && args.cursor.qid === qid && !entry.stale) {
      const who = { sid, actor: args.socket.actor };
      const resumed = await resumeOnto(
        {
          source: this.#options.source,
          budget: this.#options.budget,
          clock: this.#clock,
          gate: this.#gate,
          read: async () => {
            await pay();
            return await this.#read(entry, who);
          },
          beforeFill: pay,
        },
        entry,
        who,
        args.cursor,
        now,
      );
      const subscription = this.#attachUnlessGone(entry, args.socket, sid, resumed.cursor);
      return { subscription, frame: resumed.frame };
    }

    await pay();
    const fresh = await this.#read(entry, { sid, actor: args.socket.actor });
    const cursor = makeCursor(qid, fresh.lsn, fresh.rows, now);
    const subscription = this.#attachUnlessGone(entry, args.socket, sid, cursor);
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

  /**
   * An entry nothing is holding, dropped with the retained patches that were kept for it — the
   * same three steps `unsubscribe` takes when the last subscriber leaves, for the case where a
   * subscriber never arrived. Five cold failures against `maxEntries: 5` used to refuse every
   * later subscribe on the node with `X_SUBSCRIPTION_LIMIT`, forever, after the database recovered.
   */
  #dropIfUnheld(qid: string, entry: QueryEntry): void {
    // Identity, never presence: an entry this subscribe did not create may already have been
    // dropped and re-created under the same qid.
    if (this.#entries.get(qid) !== entry) return;
    if (entry.subscribers.size !== 0) return;
    // A read published on the entry belongs to a subscriber that has not attached yet — it owns
    // the entry's fate, and dropping it here would leave that subscriber holding a window no
    // change is ever fanned out to.
    if (entry.reading !== null) return;
    this.#entries.delete(qid);
    this.#options.source.forget?.(qid);
  }

  unsubscribeSocket(socketId: string): void {
    for (const subscription of this.#book.ofSocket(socketId)) {
      this.unsubscribe(socketId, subscription.sid);
    }
    // Held or not: a socket re-authed while holding nothing is remembered by nothing else.
    this.#book.forgetSocket(socketId);
  }

  /** Sockets the spanning caps still remember a key for. A leak is this number not falling. */
  get trackedSockets(): number {
    return this.#book.trackedSockets;
  }

  /** Live subscriptions one principal (`actor:<id>` / `address:<ip>`) holds on this node. */
  actorCount(principal: string): number {
    return this.#book.actorCount(principal);
  }

  /** Actor changed mid-connection — re-decided per subscription; `live-reauth.ts` owns how. */
  reauthorize(socket: SyncSocket): Promise<readonly string[]> {
    return reauthorizeSocket(
      {
        book: this.#book,
        gate: this.#gate,
        unsubscribe: (socketId, sid) => this.unsubscribe(socketId, sid),
        // A re-seat is the subscription it already was, so it is never charged again.
        resubscribe: (args) => this.#subscribe(args, { due: false }),
      },
      socket,
    );
  }

  /**
   * The newest change position this registry has been handed. What a node's snapshot may claim
   * (`liveQueryDefinition`'s `lsn`): a read begun after it holds at least that change, and every
   * later change is above it. `''` before the first.
   */
  get lastLsn(): string {
    return this.#lastLsn;
  }

  /** Fan one change out, every query id in its own lane — `live-deliver.ts` owns why. */
  async deliver(change: ChangeEvent): Promise<number> {
    if (change.lsn > this.#lastLsn) this.#lastLsn = change.lsn;
    return await deliverChange(this.#entries.values(), this.#fanout, change, (stale) => {
      this.#staleChanges += stale;
    });
  }

  #attachUnlessGone(
    entry: QueryEntry,
    socket: SyncSocket,
    sid: string,
    cursor: LiveCursor,
  ): LiveSubscription {
    const subscription = this.#attach(entry, socket, sid, cursor);
    // The policy pass ran outside the lane, so a change may have been folded into the window
    // between the rows this subscriber was served and this attach: it is in neither their frame
    // nor their patch stream. Marked, so the next delivery re-snapshots them out of the window.
    if (entry.lsn !== cursor.lsn) socket.markDesynced(sid);
    if (socket.closed) this.unsubscribe(socket.id, sid);
    return subscription;
  }

  #attach(
    entry: QueryEntry,
    socket: SyncSocket,
    sid: string,
    cursor: LiveCursor,
  ): LiveSubscription {
    // Before anything is written: a re-auth during the read may have moved this socket to a
    // principal that never had room for it.
    this.#book.assertAttachable(socket, sid);
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

  #entryFor(
    qid: string,
    definition: LiveQueryDefinition,
    input: JsonValue,
    tenant: string | null,
  ): QueryEntry {
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
    const created = createEntry(qid, definition, input, definition.matcher(input), {
      readDeadlineMs: this.#options.readDeadlineMs,
      schedule: this.#options.schedule,
      tenant,
    });
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
    const lsn = floorAfterRead(this.#options.source, entry, window, {
      lastLsn: this.#lastLsn,
      origin: this.#origin,
    });
    return { rows: await this.#gate.filterRows(entry, who, window.rows), lsn };
  }
}
