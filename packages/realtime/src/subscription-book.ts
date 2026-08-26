// Who holds which subscription, and the composite identity that makes that answerable. A `sid`
// is CLIENT data — unique only to the socket that chose it — so every lookup here takes the
// owner too, and the per-socket and per-tenant caps are answered from this book because it is
// the only thing that knows what exists. Every question it answers is indexed, never scanned.

import type { Actor } from '@ultimat3/core';
import { finiteOption } from '@ultimat3/core';
import { SubscriptionIdTakenError, SubscriptionLimitError } from './errors';
import type { LiveSubscription } from './live-contract';
import type { SyncSocket } from './socket';

/**
 * A slot taken synchronously at the top of `subscribe` and given back when it has either become a
 * subscription or failed. It exists because every cap here is answered from what the book HOLDS,
 * and a subscribe does not hold anything until three awaits later: one WebSocket write carrying N
 * subscribe frames is dispatched concurrently, so N of them read `size === 0` and every cap is
 * bypassed by batching. Releasing twice is a no-op — the caller's `finally` runs once per path.
 */
export interface SubscriptionSlot {
  release(): void;
}

/**
 * The identity of one subscription. `\u0000` because a socket id and a sid are both opaque
 * strings and nothing else can appear in one, so no pair of them can collide with another.
 */
export function subscriptionKey(socketId: string, sid: string): string {
  return `${socketId}\u0000${sid}`;
}

export interface SubscriptionCaps {
  readonly maxPerSocket?: number;
  readonly maxPerTenant?: number;
  readonly tenantOf?: (actor: Actor | null) => string | null;
}

/** Sockets may open this many live queries before `X_SUBSCRIPTION_LIMIT`. */
export const DEFAULT_MAX_PER_SOCKET = 128;

/**
 * Every live subscription on this node, keyed by `(socket, sid)`.
 *
 * Keyed by the sid alone, socket B reusing socket A's sid overwrote A's entry — A's subscription
 * stayed in its query entry's `subscribers` map, unreachable, so `unsubscribeSocket(A)` freed
 * nothing and that entry's matcher and shared window were pinned for the process's life, fanning
 * every change out to a dead socket. A `drop` frame from B likewise ended A's stream with no
 * error either side.
 *
 * **Two secondary indexes, because both of this book's sweeps run once per socket.** `ofSocket`
 * copied the node's whole map and filtered it, so a teardown or a re-auth pass cost
 * `sockets x subscriptions` — 100,000 entries measured at 17.7s of blocking work, with no
 * attacker capability required: a deploy, a network blip or a batch of grants expiring together
 * is the trigger. The per-tenant cap walked the same map on every subscribe FRAME (7.96 ms each
 * at that size), which is one authenticated socket consuming the node. Both are `Map` reads now,
 * maintained in `add`/`delete` — the shape `lru.ts` and `presence.ts` already use.
 */
export class SubscriptionBook {
  readonly #bySid = new Map<string, LiveSubscription>();
  /** socket id -> its sids. The drop list on close, the retry list on re-auth. */
  readonly #bySocket = new Map<string, Set<string>>();
  /** tenant -> live subscriptions held by its sockets. The per-tenant cap's whole answer. */
  readonly #perTenant = new Map<string, number>();
  /**
   * The tenant each socket's subscriptions were counted under. Remembered rather than re-derived,
   * because `socket.actor` is replaced by a re-auth: deriving it again at `delete` time would
   * decrement a tenant that was never incremented and leave the old one counting forever.
   */
  readonly #tenantOfSocket = new Map<string, string>();
  /** sids a socket has claimed but not yet attached. Empty between subscribes, so it never grows. */
  readonly #claimedBySocket = new Map<string, Set<string>>();
  /** The same claims counted per tenant, because that cap spans sockets and a lane cannot see it. */
  readonly #claimedPerTenant = new Map<string, number>();
  readonly #caps: SubscriptionCaps;

  constructor(caps: SubscriptionCaps = {}) {
    this.#caps = caps;
  }

  get(socketId: string, sid: string): LiveSubscription | undefined {
    return this.#bySid.get(subscriptionKey(socketId, sid));
  }

  has(socketId: string, sid: string): boolean {
    return this.#bySid.has(subscriptionKey(socketId, sid));
  }

  add(subscription: LiveSubscription): void {
    const socketId = subscription.socket.id;
    const key = subscriptionKey(socketId, subscription.sid);
    // A re-add is the one thing that could double-count a tenant, so it is refused here rather
    // than relied on not to happen: `subscribe` already answers `X_SUBSCRIPTION_ID_TAKEN`.
    if (this.#bySid.has(key)) return;
    this.#bySid.set(key, subscription);
    const sids = this.#bySocket.get(socketId);
    if (sids) sids.add(subscription.sid);
    else this.#bySocket.set(socketId, new Set([subscription.sid]));
    const tenant = this.#tenantFor(subscription.socket);
    if (tenant === null) return;
    this.#tenantOfSocket.set(socketId, tenant);
    this.#perTenant.set(tenant, (this.#perTenant.get(tenant) ?? 0) + 1);
  }

  delete(socketId: string, sid: string): void {
    if (!this.#bySid.delete(subscriptionKey(socketId, sid))) return;
    const sids = this.#bySocket.get(socketId);
    sids?.delete(sid);
    const empty = sids === undefined || sids.size === 0;
    if (empty) this.#bySocket.delete(socketId);
    const tenant = this.#tenantOfSocket.get(socketId);
    if (tenant === undefined) return;
    this.#bump(tenant, -1);
    if (empty) this.#tenantOfSocket.delete(socketId);
  }

  /** A copy, because every caller mutates the book while walking it. */
  all(): readonly LiveSubscription[] {
    return [...this.#bySid.values()];
  }

  /** One socket's subscriptions — the drop list when it closes, the retry list when it reauths. */
  ofSocket(socketId: string): readonly LiveSubscription[] {
    const sids = this.#bySocket.get(socketId);
    if (!sids) return [];
    const out: LiveSubscription[] = [];
    for (const sid of sids) {
      const subscription = this.#bySid.get(subscriptionKey(socketId, sid));
      if (subscription) out.push(subscription);
    }
    return out;
  }

  /** Live subscriptions counted against one tenant. The metric the cap reads. */
  tenantCount(tenant: string): number {
    return this.#perTenant.get(tenant) ?? 0;
  }

  /**
   * A re-auth moved this socket to another tenant, so its subscriptions move with it. Without
   * this the count the cap reads drifts from the book for the rest of the process — one tenant
   * refused for subscriptions it does not hold, another admitted past its cap.
   */
  retenant(socket: SyncSocket): void {
    const held = this.#bySocket.get(socket.id)?.size ?? 0;
    const before = this.#tenantOfSocket.get(socket.id) ?? null;
    const after = this.#caps.tenantOf?.(socket.actor) ?? null;
    if (before === after) return;
    if (before !== null) this.#bump(before, -held);
    if (after === null) this.#tenantOfSocket.delete(socket.id);
    else {
      this.#tenantOfSocket.set(socket.id, after);
      if (held > 0) this.#perTenant.set(after, (this.#perTenant.get(after) ?? 0) + held);
    }
  }

  /**
   * Refuse a subscribe that would exceed a cap. Load shedding, not a crash: both scopes throw
   * `X_SUBSCRIPTION_LIMIT` naming which one refused, so the fix line points at one knob.
   *
   * Claims count, because the thing being bounded is work that starts before it is held: a
   * subscribe that has passed this check and is awaiting its snapshot has already committed this
   * node to an entry, a matcher and a read.
   */
  assertCapacity(socket: SyncSocket): void {
    const perSocket = finiteOption(
      'the subscription caps',
      'maxPerSocket',
      this.#caps.maxPerSocket ?? DEFAULT_MAX_PER_SOCKET,
    );
    const claimed = this.#claimedBySocket.get(socket.id)?.size ?? 0;
    if (socket.queries.size + claimed >= perSocket) {
      throw new SubscriptionLimitError({
        scope: 'socket',
        id: socket.id,
        limit: perSocket,
        knob: 'maxPerSocket',
      });
    }
    const perTenant = this.#caps.maxPerTenant;
    const tenant = this.#tenantFor(socket);
    if (perTenant === undefined || tenant === null) return;
    if (this.tenantCount(tenant) + (this.#claimedPerTenant.get(tenant) ?? 0) >= perTenant) {
      throw new SubscriptionLimitError({
        scope: 'tenant',
        id: tenant,
        limit: perTenant,
        knob: 'maxPerTenant',
      });
    }
  }

  /**
   * Take the slot this subscribe is going to fill — the sid and the two caps — before it awaits
   * anything. Every refusal a subscribe can answer with is decided here, in one synchronous step,
   * so N frames arriving in one write are N decisions against a count that already includes the
   * ones still in flight.
   *
   * The sid is claimed here for the same reason: keyed by `(socket, sid)`, two concurrent frames
   * reusing one sid both passed `has()` and the second attach replaced the first, stranding it
   * inside its query entry where nothing can reach it again. The tenant is captured rather than
   * re-derived — a re-auth may `retenant` this socket while the read is in flight, and the release
   * has to give the slot back to the tenant that took it.
   */
  reserve(socket: SyncSocket, sid: string): SubscriptionSlot {
    const socketId = socket.id;
    if (this.has(socketId, sid) || this.#claimedBySocket.get(socketId)?.has(sid) === true) {
      throw new SubscriptionIdTakenError({ sid, socketId });
    }
    this.assertCapacity(socket);
    const claims = this.#claimedBySocket.get(socketId);
    if (claims) claims.add(sid);
    else this.#claimedBySocket.set(socketId, new Set([sid]));
    const tenant = this.#tenantFor(socket);
    if (tenant !== null) {
      this.#claimedPerTenant.set(tenant, (this.#claimedPerTenant.get(tenant) ?? 0) + 1);
    }
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        const held = this.#claimedBySocket.get(socketId);
        held?.delete(sid);
        if (held !== undefined && held.size === 0) this.#claimedBySocket.delete(socketId);
        if (tenant === null) return;
        const next = (this.#claimedPerTenant.get(tenant) ?? 0) - 1;
        if (next > 0) this.#claimedPerTenant.set(tenant, next);
        else this.#claimedPerTenant.delete(tenant);
      },
    };
  }

  /** The tenant this socket's subscriptions are counted under: the remembered one, or the actor's. */
  #tenantFor(socket: SyncSocket): string | null {
    return this.#tenantOfSocket.get(socket.id) ?? this.#caps.tenantOf?.(socket.actor) ?? null;
  }

  #bump(tenant: string, by: number): void {
    const next = (this.#perTenant.get(tenant) ?? 0) + by;
    if (next > 0) this.#perTenant.set(tenant, next);
    else this.#perTenant.delete(tenant);
  }
}
