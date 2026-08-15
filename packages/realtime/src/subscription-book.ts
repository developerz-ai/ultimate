// Who holds which subscription, and the composite identity that makes that answerable. A `sid`
// is CLIENT data — unique only to the socket that chose it — so every lookup here takes the
// owner too, and the per-socket and per-tenant caps are answered from this book because it is
// the only thing that knows what exists.

import type { Actor } from '@ultimat3/core';
import { SubscriptionLimitError } from './errors';
import type { LiveSubscription } from './live-query';
import type { SyncSocket } from './socket';

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
 */
export class SubscriptionBook {
  readonly #bySid = new Map<string, LiveSubscription>();

  get(socketId: string, sid: string): LiveSubscription | undefined {
    return this.#bySid.get(subscriptionKey(socketId, sid));
  }

  has(socketId: string, sid: string): boolean {
    return this.#bySid.has(subscriptionKey(socketId, sid));
  }

  add(subscription: LiveSubscription): void {
    this.#bySid.set(subscriptionKey(subscription.socket.id, subscription.sid), subscription);
  }

  delete(socketId: string, sid: string): void {
    this.#bySid.delete(subscriptionKey(socketId, sid));
  }

  /** A copy, because every caller mutates the book while walking it. */
  all(): readonly LiveSubscription[] {
    return [...this.#bySid.values()];
  }

  /** One socket's subscriptions — the drop list when it closes, the retry list when it reauths. */
  ofSocket(socketId: string): readonly LiveSubscription[] {
    return this.all().filter((subscription) => subscription.socket.id === socketId);
  }

  /**
   * Refuse a subscribe that would exceed a cap. Load shedding, not a crash: both scopes throw
   * `X_SUBSCRIPTION_LIMIT` naming which one refused, so the fix line points at one knob.
   */
  assertCapacity(socket: SyncSocket, caps: SubscriptionCaps): void {
    const perSocket = caps.maxPerSocket ?? DEFAULT_MAX_PER_SOCKET;
    if (socket.queries.size >= perSocket) {
      throw new SubscriptionLimitError({ scope: 'socket', id: socket.id, limit: perSocket });
    }
    const perTenant = caps.maxPerTenant;
    const tenant = caps.tenantOf?.(socket.actor) ?? null;
    if (perTenant === undefined || tenant === null) return;
    let count = 0;
    for (const subscription of this.#bySid.values()) {
      if ((caps.tenantOf?.(subscription.socket.actor) ?? null) === tenant) count += 1;
    }
    if (count >= perTenant) {
      throw new SubscriptionLimitError({ scope: 'tenant', id: tenant, limit: perTenant });
    }
  }
}
