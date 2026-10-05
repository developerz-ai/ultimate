// Who holds which subscription, and the composite identity that makes that answerable. A `sid`
// is CLIENT data — unique only to the socket that chose it — so every lookup here takes the
// owner too, and the per-socket, per-tenant and per-actor caps are answered from this book because
// it is the only thing that knows what exists. Every question it answers is indexed, never scanned.

import type { Actor } from '@ultimat3/core';
import { addressNetwork, ConfigInvalidError, finiteOption, isAnonymous } from '@ultimat3/core';
import { SubscriptionIdTakenError, SubscriptionLimitError } from './errors';
import type { LiveSubscription } from './live-contract';
import type { SyncSocket } from './socket';
import { CappedCount } from './subscription-count';

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
  /** Live subscriptions one actor may hold on this node, across all of its sockets. */
  readonly maxPerActor?: number;
}

/** Sockets may open this many live queries before `X_SUBSCRIPTION_LIMIT`. */
export const DEFAULT_MAX_PER_SOCKET = 128;

/**
 * One actor's share of a node, across every socket it opens. A tenth of `DEFAULT_MAX_ENTRIES`
 * (10,000), so no single actor reaches the node cap — before it, 79 sockets at 128 each filled the
 * node and every other user's next subscribe was refused — and eight tabs at the per-socket 128
 * still fit under it. `@ultimat3/core`'s `realtime.maxSubscriptionsPerActor` defaults to the same
 * number; `runtime-realtime.test.ts` in `@ultimat3/cli` holds the two together.
 */
export const DEFAULT_MAX_PER_ACTOR = 1_000;

/**
 * Who a socket counts against for the per-actor caps (subscriptions, and sockets at the upgrade):
 * the actor, or — anonymous — the NETWORK of the client address resolved at the upgrade
 * (`addressNetwork`: IPv4 exact, IPv6 by /64), so a visitor with no account is bounded too, and one
 * IPv6 host cannot rotate through its /64 for a fresh budget per address. A socket that names
 * neither shares ONE principal, `address:unknown`: fail closed, bounded together, not unbounded.
 */
export function principalOf(socket: Pick<SyncSocket, 'actor' | 'clientAddress'>): string {
  return principalFor(socket.actor, socket.clientAddress);
}

/** The same key from its two parts — the upgrade has them before any socket exists. */
export function principalFor(actor: Actor | null, clientAddress: string | null): string {
  if (actor !== null && !isAnonymous(actor)) return `actor:${actor.id}`;
  return `address:${clientAddress === null ? 'unknown' : addressNetwork(clientAddress)}`;
}

/** A per-actor ceiling is a COUNT of at least 1, refused as the config key of the same name is. */
function actorCeiling(value: number | undefined): number {
  const max = value ?? DEFAULT_MAX_PER_ACTOR;
  if (Number.isSafeInteger(max) && max >= 1) return max;
  throw new ConfigInvalidError({
    cause: `maxPerActor (realtime.maxSubscriptionsPerActor) must be a whole number of at least 1, not ${String(max)} — 0 refuses every subscribe, and a fraction or a NaN is a cap no count ever reaches`,
    fix: `new LiveQueryRegistry({ maxPerActor: ${String(DEFAULT_MAX_PER_ACTOR)} })   # or realtime: { maxSubscriptionsPerActor: ${String(DEFAULT_MAX_PER_ACTOR)} } in app.config.ts`,
    meta: { key: 'realtime.maxSubscriptionsPerActor', value: max },
  });
}

const SUBJECT = 'the subscription caps';

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
  /** sids a socket has claimed but not yet attached. Empty between subscribes, so it never grows. */
  readonly #claimedBySocket = new Map<string, Set<string>>();
  /** The keys each in-flight claim was counted under, by `(socket, sid)` — read at attach. */
  readonly #claimKeys = new Map<string, { tenant: string | null; actor: string | null }>();
  /** The caps that span sockets: one per tenant (opt-in), one per actor (always). */
  readonly #tenants: CappedCount;
  readonly #actors: CappedCount;
  readonly #caps: SubscriptionCaps;
  /**
   * Every cap screened here, once, rather than on the subscribe path — and `maxPerTenant` was not
   * screened at all: it has no `??` default, which is the one shape `bun run finite-bounds` states
   * in its own header that it cannot see. `count >= NaN` is false, so the only cap that spans the
   * sockets of one tenant was off in silence; measured, a book built with `maxPerTenant: NaN`
   * admitted 5,000 subscribes for one tenant. `undefined` stays `undefined`, because there the
   * caller is saying "no per-tenant cap" rather than handing a number that is not one.
   */
  readonly #maxPerSocket: number;

  constructor(caps: SubscriptionCaps = {}) {
    this.#caps = caps;
    this.#maxPerSocket = finiteOption(
      SUBJECT,
      'maxPerSocket',
      caps.maxPerSocket ?? DEFAULT_MAX_PER_SOCKET,
    );
    this.#tenants = new CappedCount({
      principalOf: (socket) => this.#caps.tenantOf?.(socket.actor) ?? null,
      max:
        caps.maxPerTenant === undefined
          ? undefined
          : finiteOption(SUBJECT, 'maxPerTenant', caps.maxPerTenant),
      scope: 'tenant',
      knob: 'maxPerTenant',
    });
    this.#actors = new CappedCount({
      principalOf,
      max: actorCeiling(caps.maxPerActor),
      scope: 'actor',
      knob: 'realtime.maxSubscriptionsPerActor',
    });
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
    this.#tenants.added(subscription.socket);
    this.#actors.added(subscription.socket);
  }

  delete(socketId: string, sid: string): void {
    if (!this.#bySid.delete(subscriptionKey(socketId, sid))) return;
    const sids = this.#bySocket.get(socketId);
    sids?.delete(sid);
    const empty = sids === undefined || sids.size === 0;
    if (empty) this.#bySocket.delete(socketId);
    this.#tenants.deleted(socketId, empty);
    this.#actors.deleted(socketId, empty);
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
    return this.#tenants.count(tenant);
  }

  /**
   * A re-auth moved this socket to another tenant — or another actor — so its subscriptions move
   * with it. Without this the counts the caps read drift from the book for the rest of the process:
   * one key refused for subscriptions it does not hold, another admitted past its cap.
   */
  retenant(socket: SyncSocket): void {
    const held = this.#bySocket.get(socket.id)?.size ?? 0;
    this.#tenants.reassign(socket, held);
    this.#actors.reassign(socket, held);
  }

  /**
   * About to attach `(socket, sid)`: if a re-auth moved the socket to another tenant or actor
   * while the subscribe was in flight, the new key was never asked — ask it now, and refuse when
   * it is full. Called before the attach writes anything, so a refusal leaves nothing behind.
   */
  assertAttachable(socket: SyncSocket, sid: string): void {
    const claimed = this.#claimKeys.get(subscriptionKey(socket.id, sid));
    if (claimed === undefined) return;
    this.#tenants.assertIfMoved(socket, claimed.tenant);
    this.#actors.assertIfMoved(socket, claimed.actor);
  }

  /**
   * How many of this socket's subscriptions a re-auth must refuse so that neither its new tenant
   * nor its new actor ends above its cap, and the refusal to send each — `null` when all fit.
   * Asked BEFORE `retenant`, so the refused ones leave the key they were counted under.
   */
  overflowOnRekey(
    socket: SyncSocket,
  ): { readonly excess: number; readonly error: SubscriptionLimitError } | null {
    const held = this.#bySocket.get(socket.id)?.size ?? 0;
    const byActor = this.#actors.overflowOnRekey(socket, held);
    const byTenant = this.#tenants.overflowOnRekey(socket, held);
    if (byActor === 0 && byTenant === 0) return null;
    return byActor >= byTenant
      ? { excess: byActor, error: this.#actors.refusalFor(socket) }
      : { excess: byTenant, error: this.#tenants.refusalFor(socket) };
  }

  /** The socket closed: forget the keys it was counted under, held or not. */
  forgetSocket(socketId: string): void {
    this.#tenants.forget(socketId);
    this.#actors.forget(socketId);
  }

  /** Sockets either spanning cap still remembers — a leak shows here first. */
  get trackedSockets(): number {
    return this.#tenants.remembered + this.#actors.remembered;
  }

  /** Live subscriptions counted against one principal (`actor:<id>` / `address:<ip>`). */
  actorCount(principal: string): number {
    return this.#actors.count(principal);
  }

  /**
   * Refuse a subscribe that would exceed a cap. Load shedding, not a crash: every scope throws
   * `X_SUBSCRIPTION_LIMIT` naming which one refused, so the fix line points at one knob.
   *
   * Claims count, because the thing being bounded is work that starts before it is held: a
   * subscribe that has passed this check and is awaiting its snapshot has already committed this
   * node to an entry, a matcher and a read.
   */
  assertCapacity(socket: SyncSocket): void {
    const perSocket = this.#maxPerSocket;
    const claimed = this.#claimedBySocket.get(socket.id)?.size ?? 0;
    if (socket.queries.size + claimed >= perSocket) {
      throw new SubscriptionLimitError({
        scope: 'socket',
        id: socket.id,
        limit: perSocket,
        knob: 'maxPerSocket',
      });
    }
    this.#tenants.assert(socket);
    this.#actors.assert(socket);
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
    const tenant = this.#tenants.claim(socket);
    const actor = this.#actors.claim(socket);
    const claimKey = subscriptionKey(socketId, sid);
    this.#claimKeys.set(claimKey, { tenant: tenant.principal, actor: actor.principal });
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        const held = this.#claimedBySocket.get(socketId);
        held?.delete(sid);
        if (held !== undefined && held.size === 0) this.#claimedBySocket.delete(socketId);
        this.#claimKeys.delete(claimKey);
        tenant.release();
        actor.release();
      },
    };
  }
}
