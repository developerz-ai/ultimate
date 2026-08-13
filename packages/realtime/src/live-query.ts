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
import { isPolicyDenial, ProtocolVersionError, SubscriptionLimitError } from './errors';
import { canonicalJson, fnv1a, type JsonValue, type Row, type RowPatch } from './json';
import {
  applyToWindow,
  bridgeChange,
  type IncrementalMatcher,
  type SubscriptionShape,
} from './matcher-bridge';
import type { SyncSocket } from './socket';
import { type Subscriber, SubscriberGate, type SubscriberGateOptions } from './subscriber-gate';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

/** `qid` = hash(query name, input). Fanout subjects and change windows are keyed by it. */
export function qidOf(name: string, input: JsonValue): string {
  return `${name}:${fnv1a(canonicalJson(input))}`;
}

export interface SnapshotResult<R extends Row = Row> {
  readonly rows: readonly R[];
  readonly lsn: string;
}

export interface LiveQueryDefinition<R extends Row = Row> {
  readonly name: string;
  /** Dependency set for the pre-filter. `x verify` rejects a `live: true` query without one. */
  readonly entities: readonly string[];
  /** Read set. Lets the pre-filter skip updates that touch no column this query reads. */
  readonly columns?: readonly string[];
  /** Bounded read (`orderBy` + `limit`, enforced by `x verify`), unfiltered by policy. */
  snapshot(args: { input: JsonValue }): Promise<SnapshotResult<R>>;
  /** Subscribe-time gate. Throws to deny — the same `policy` used by HTTP, jobs, and MCP. */
  authorize?(args: { actor: Actor | null; input: JsonValue }): void | Promise<void>;
  /** Row-level gate, evaluated per subscriber. The only row filter in the pipeline. */
  visible(args: { actor: Actor | null; row: R; input: JsonValue }): boolean | Promise<boolean>;
  /** Built once per `qid`, since a qid pins both the query and its input. */
  matcher(input: JsonValue): IncrementalMatcher;
  /**
   * Resolve whatever this input needs before an entry is built. `matcher` is synchronous by
   * design — a change event must not await anything — so a definition that has to compile a
   * source or a shape does it here, after `authorize` allowed this subscriber and before the
   * shared window exists.
   */
  prepare?(input: JsonValue): Promise<void>;
}

export interface LiveSubscription {
  readonly sid: string;
  readonly qid: string;
  readonly socket: SyncSocket;
  readonly input: JsonValue;
  readonly definition: LiveQueryDefinition;
  cursor: LiveCursor;
}

export interface LiveQueryRegistryOptions extends SubscriberGateOptions {
  readonly source: ResumeSource;
  readonly budget?: ReconnectBudget;
  readonly clock?: Clock;
  readonly maxPerSocket?: number;
  readonly maxPerTenant?: number;
  readonly tenantOf?: (actor: Actor | null) => string | null;
}

interface QueryEntry {
  readonly qid: string;
  readonly definition: LiveQueryDefinition;
  readonly input: JsonValue;
  readonly shape: SubscriptionShape;
  readonly matcher: IncrementalMatcher;
  readonly subscribers: Map<string, LiveSubscription>;
  /**
   * The shared, *pre-policy* result window. One per query id, bounded by the query's `limit`, and
   * the reason the matcher can run once for N subscribers: the read is shared, the authz is not.
   */
  rows: readonly Row[];
  lsn: string;
}

export class LiveQueryRegistry {
  readonly #definitions = new Map<string, LiveQueryDefinition>();
  readonly #entries = new Map<string, QueryEntry>();
  readonly #bySid = new Map<string, LiveSubscription>();
  readonly #options: LiveQueryRegistryOptions;
  readonly #clock: Clock;
  readonly #gate: SubscriberGate;

  constructor(options: LiveQueryRegistryOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#gate = new SubscriberGate(options);
  }

  /** `live.rows_denied` for this node: rows a subscriber's policy refused since boot. */
  get rowsDenied(): number {
    return this.#gate.rowsDenied;
  }

  /** `live.gate_failed` for this node: gates that raised instead of deciding. Never a denial. */
  get gateFailures(): number {
    return this.#gate.gateFailures;
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

  subscription(sid: string): LiveSubscription | undefined {
    return this.#bySid.get(sid);
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
    if (!definition) {
      throw new ProtocolVersionError({
        got: args.name,
        expected: PROTOCOL_VERSION,
        detail: `no live query registered as "${args.name}" — client and server manifests differ`,
      });
    }
    this.#assertLimits(args.socket);
    await definition.authorize?.({ actor: args.socket.actor, input: args.input });
    // After this subscriber's own decision, never before it: resolving a shape for a caller who
    // may not subscribe is work an unauthorized client gets to schedule.
    await definition.prepare?.(args.input);

    const qid = qidOf(args.name, args.input);
    const entry = this.#entryFor(qid, definition, args.input);
    const sid = args.sid ?? uuid();
    const now = this.#clock.now().getTime();

    if (args.cursor) {
      const resumed = await resumeFrom(args.cursor, {
        source: this.#options.source,
        ...(this.#options.budget ? { budget: this.#options.budget } : {}),
        clock: this.#clock,
        snapshot: async () => await this.#read(entry, { sid, actor: args.socket.actor }),
      });
      if (resumed.kind === 'delta') {
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
        frame: {
          type: 'snapshot',
          v: PROTOCOL_VERSION,
          sid,
          rows: resumed.rows,
          cursor: resumed.cursor,
        },
      };
    }

    const fresh = await this.#read(entry, { sid, actor: args.socket.actor });
    const cursor = makeCursor(qid, fresh.lsn, fresh.rows, now);
    const subscription = this.#attach(entry, args.socket, sid, cursor);
    return {
      subscription,
      frame: { type: 'snapshot', v: PROTOCOL_VERSION, sid, rows: fresh.rows, cursor },
    };
  }

  unsubscribe(sid: string): void {
    const subscription = this.#bySid.get(sid);
    if (!subscription) return;
    this.#bySid.delete(sid);
    subscription.socket.queries.delete(sid);
    subscription.socket.clearDesynced(sid);
    const entry = this.#entries.get(subscription.qid);
    if (!entry) return;
    entry.subscribers.delete(sid);
    // An entry with no subscribers stops costing a matcher and a change window.
    if (entry.subscribers.size === 0) this.#entries.delete(subscription.qid);
  }

  unsubscribeSocket(socketId: string): void {
    for (const subscription of [...this.#bySid.values()]) {
      if (subscription.socket.id === socketId) this.unsubscribe(subscription.sid);
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
    for (const subscription of [...this.#bySid.values()]) {
      if (subscription.socket.id !== socket.id) continue;
      try {
        await subscription.definition.authorize?.({
          actor: socket.actor,
          input: subscription.input,
        });
      } catch (error) {
        if (isPolicyDenial(error)) {
          this.unsubscribe(subscription.sid);
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
   */
  async deliver(change: ChangeEvent): Promise<number> {
    let sent = 0;
    for (const entry of this.#entries.values()) {
      const result = bridgeChange(entry.shape, entry.matcher, change, entry.rows);
      if (!result) continue;
      entry.lsn = change.lsn;
      entry.rows = applyToWindow(entry.rows, result.patches);
      // The retained window holds the pre-policy patch; resume re-filters it per subscriber.
      for (const patch of result.patches) this.#options.source.append(entry.qid, patch);

      for (const subscription of entry.subscribers.values()) {
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
    }
    return sent;
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
    entry.subscribers.set(sid, subscription);
    this.#bySid.set(sid, subscription);
    socket.queries.set(sid, entry.qid);
    socket.clearDesynced(sid);
    return subscription;
  }

  #entryFor(qid: string, definition: LiveQueryDefinition, input: JsonValue): QueryEntry {
    const existing = this.#entries.get(qid);
    if (existing) return existing;
    const matcher = definition.matcher(input);
    const created: QueryEntry = {
      qid,
      definition,
      input,
      shape: {
        qid,
        // The matcher knows the dependency set this *input* produced; `definition.entities` is
        // the static declaration and can only be a superset of it. Preferring the matcher is what
        // lets a definition built from a real query carry no static list at all.
        entities: matcher.entities.length > 0 ? matcher.entities : definition.entities,
        orgId: orgIdOf(input),
        ...(definition.columns ? { columns: definition.columns } : {}),
      },
      matcher,
      subscribers: new Map(),
      rows: [],
      lsn: '',
    };
    this.#entries.set(qid, created);
    return created;
  }

  /**
   * One read, then one policy pass per subscriber. Never one read per subscriber — and never a
   * partial pass: a gate that fails raises out of `subscribe`, because a snapshot missing the rows
   * nobody could decide about is a short result set this subscriber would render as the whole one.
   */
  async #read(entry: QueryEntry, who: Subscriber): Promise<SnapshotResult> {
    const result = await entry.definition.snapshot({ input: entry.input });
    entry.rows = result.rows;
    entry.lsn = result.lsn;
    return { rows: await this.#gate.filterRows(entry, who, result.rows), lsn: result.lsn };
  }

  #assertLimits(socket: SyncSocket): void {
    const perSocket = this.#options.maxPerSocket ?? 128;
    if (socket.queries.size >= perSocket) {
      throw new SubscriptionLimitError({ scope: 'socket', id: socket.id, limit: perSocket });
    }
    const perTenant = this.#options.maxPerTenant;
    const tenant = this.#options.tenantOf?.(socket.actor) ?? null;
    if (perTenant === undefined || tenant === null) return;
    let count = 0;
    for (const subscription of this.#bySid.values()) {
      if ((this.#options.tenantOf?.(subscription.socket.actor) ?? null) === tenant) count += 1;
    }
    if (count >= perTenant) {
      throw new SubscriptionLimitError({ scope: 'tenant', id: tenant, limit: perTenant });
    }
  }
}

function orgIdOf(input: JsonValue): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input['orgId'];
  return typeof value === 'string' ? value : null;
}
