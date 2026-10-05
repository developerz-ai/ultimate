// One cap that spans sockets: live subscriptions counted per KEY (a tenant, an actor), held plus
// reserved, with the key each socket was counted under remembered. Split from
// `subscription-book.ts` so the tenant cap and the actor cap are one mechanism, not two copies.

import { SubscriptionLimitError } from './errors';
import type { SyncSocket } from './socket';

export interface CappedCountInit {
  /** Which key a socket's subscriptions count against, or `null` for none (uncapped here). */
  readonly principalOf: (socket: SyncSocket) => string | null;
  /** `undefined` counts without refusing — the tenant cap's opt-out. Screened by the caller. */
  readonly max: number | undefined;
  readonly scope: 'tenant' | 'actor';
  readonly knob: string;
}

/**
 * Every question answered from a `Map`, never a scan: the cap is asked on every subscribe frame,
 * and walking the node's subscriptions for it was one socket consuming the node.
 */
export class CappedCount {
  readonly #init: CappedCountInit;
  readonly #held = new Map<string, number>();
  readonly #claimed = new Map<string, number>();
  /**
   * The key each socket's subscriptions were counted under. Remembered rather than re-derived,
   * because `socket.actor` is replaced by a re-auth: deriving it again at `delete` time would
   * decrement a key that was never incremented and leave the old one counting forever.
   */
  readonly #principalOfSocket = new Map<string, string>();

  constructor(init: CappedCountInit) {
    this.#init = init;
  }

  count(key: string): number {
    return this.#held.get(key) ?? 0;
  }

  /** The key a socket counts under: the remembered one, or what its actor says now. */
  principalFor(socket: SyncSocket): string | null {
    return this.#principalOfSocket.get(socket.id) ?? this.#init.principalOf(socket);
  }

  /** Claims count: a subscribe past this check has already committed the node to its work. */
  assert(socket: SyncSocket): void {
    const max = this.#init.max;
    const key = this.principalFor(socket);
    if (max === undefined || key === null) return;
    if (this.count(key) + (this.#claimed.get(key) ?? 0) >= max) {
      throw new SubscriptionLimitError({
        scope: this.#init.scope,
        id: key,
        limit: max,
        knob: this.#init.knob,
      });
    }
  }

  /** A reservation, given back to the key that took it even if the socket re-keys meanwhile. */
  claim(socket: SyncSocket): { readonly principal: string | null; readonly release: () => void } {
    const key = this.principalFor(socket);
    if (key === null) return { principal: key, release: () => undefined };
    bump(this.#claimed, key, 1);
    return { principal: key, release: () => bump(this.#claimed, key, -1) };
  }

  /**
   * A subscribe reserved under `claimedPrincipal` is attaching, and its socket now counts under another
   * key (a re-auth landed while it was in flight): it joins the new key only if that key has room —
   * the check the new key never got at reserve time.
   */
  assertIfMoved(socket: SyncSocket, claimedPrincipal: string | null): void {
    if (this.principalFor(socket) !== claimedPrincipal) this.assert(socket);
  }

  /**
   * How many of a socket's `held` subscriptions the key it is about to move to cannot take — `0`
   * when it is not moving or there is room. A re-auth refuses that many rather than carrying a key
   * past its cap: moving 128 onto a principal at 1,000 was 1,128, and filling an address then
   * signing in was a way to repeat it.
   */
  overflowOnRekey(socket: SyncSocket, held: number): number {
    const max = this.#init.max;
    const after = this.#init.principalOf(socket);
    if (max === undefined || after === null || held === 0) return 0;
    if (after === (this.#principalOfSocket.get(socket.id) ?? null)) return 0;
    const room = max - this.count(after) - (this.#claimed.get(after) ?? 0);
    return Math.max(0, held - Math.max(0, room));
  }

  /** The refusal this cap answers for the key `socket` would count under. */
  refusalFor(socket: SyncSocket): SubscriptionLimitError {
    return new SubscriptionLimitError({
      scope: this.#init.scope,
      id: this.#init.principalOf(socket) ?? 'unknown',
      limit: this.#init.max ?? 0,
      knob: this.#init.knob,
    });
  }

  /** The socket closed: nothing it remembers may outlive it. */
  forget(socketId: string): void {
    this.#principalOfSocket.delete(socketId);
  }

  /** Sockets this cap still remembers a key for — bounded by sockets that hold a subscription. */
  get remembered(): number {
    return this.#principalOfSocket.size;
  }

  added(socket: SyncSocket): void {
    const key = this.principalFor(socket);
    if (key === null) return;
    this.#principalOfSocket.set(socket.id, key);
    bump(this.#held, key, 1);
  }

  /** `emptied`: the socket now holds nothing, so its remembered key goes too. */
  deleted(socketId: string, emptied: boolean): void {
    const key = this.#principalOfSocket.get(socketId);
    if (key === undefined) return;
    bump(this.#held, key, -1);
    if (emptied) this.#principalOfSocket.delete(socketId);
  }

  /** A re-auth moved the socket to another key: its `held` subscriptions move with it. */
  reassign(socket: SyncSocket, held: number): void {
    // Holding nothing, there is nothing to move and nothing to remember: `keyFor` falls back to
    // the actor's key. Stored anyway, a re-auth on an idle socket was an entry nothing deleted.
    if (held === 0) {
      this.#principalOfSocket.delete(socket.id);
      return;
    }
    const before = this.#principalOfSocket.get(socket.id) ?? null;
    const after = this.#init.principalOf(socket);
    if (before === after) return;
    if (before !== null) bump(this.#held, before, -held);
    if (after === null) this.#principalOfSocket.delete(socket.id);
    else {
      this.#principalOfSocket.set(socket.id, after);
      if (held > 0) bump(this.#held, after, held);
    }
  }
}

function bump(map: Map<string, number>, key: string, by: number): void {
  const next = (map.get(key) ?? 0) + by;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}
