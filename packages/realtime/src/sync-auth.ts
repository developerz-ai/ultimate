// Who a socket is, and for how long. The `sync` node evaluates no credential of its own — an app
// supplies `authenticate`, exactly as it supplies `onMutate` — so this file owns the shape of that
// answer, the per-node book that holds it, and the pass that re-decides one whose window has closed.

import type { Actor, Clock } from '@ultimat3/core';

/**
 * One connection's identity. A grant, not an `Actor`, because a websocket outlives every credential
 * that opened it: a token with a 15-minute TTL on a socket that stays up for hours is a subscription
 * authorized once and served forever, which is the hole `expiresAt` closes.
 *
 * `refresh` is the app's, and the framework retains no credential of its own for it. That is the
 * whole reason the seam is a closure: re-reading the upgrade `Request` would mean holding one per
 * socket for the life of the connection, and an app that closes over a token string holds the two
 * fields it actually needs. Omit it and an expired grant simply closes the socket — the client
 * re-dials with a fresh credential, which is the safe default and costs one reconnect.
 */
export interface SyncGrant {
  readonly actor: Actor;
  /** Epoch ms this grant stops being true. Omitted = never re-decided on a clock. */
  readonly expiresAt?: number;
  /** Re-resolve this connection without a reconnect. `null` means the actor is gone. */
  refresh?: () => Promise<SyncGrant | null>;
}

/**
 * The app's answer to "who is dialling". Called once per upgrade, before `server.upgrade`, so a
 * refused credential never costs a websocket. `null` is a decision (nobody may open this socket);
 * a throw is a failure (nothing was decided) — the node answers those differently, because reading
 * an auth backend timeout as a denial is the same class of bug as reading a dead pool as a row
 * policy refusing a row.
 */
export type SyncAuthenticator = (request: Request) => Promise<SyncGrant | null>;

/**
 * The grants of the sockets on this node, keyed by socket id.
 *
 * Off `SyncSocket` on purpose: that object's budget is ~1KB per connection and it is the only
 * per-socket allocation a million-socket node is costed against, so an auth lifetime — a closure,
 * an expiry and an actor — lives beside the socket table instead of inside it. Empty, and costing
 * nothing, on a node with no authenticator.
 */
export class GrantBook {
  readonly #grants = new Map<string, SyncGrant>();

  set(socketId: string, grant: SyncGrant): void {
    this.#grants.set(socketId, grant);
  }

  get(socketId: string): SyncGrant | undefined {
    return this.#grants.get(socketId);
  }

  delete(socketId: string): void {
    this.#grants.delete(socketId);
  }

  get size(): number {
    return this.#grants.size;
  }

  /** Grants whose window has closed. One with no `expiresAt` never appears here. */
  expired(now: number): readonly (readonly [string, SyncGrant])[] {
    const out: (readonly [string, SyncGrant])[] = [];
    for (const [socketId, grant] of this.#grants) {
      if (grant.expiresAt !== undefined && grant.expiresAt <= now) out.push([socketId, grant]);
    }
    return out;
  }
}

export interface GrantSweepDeps {
  readonly grants: GrantBook;
  readonly clock: Clock;
  /** The grant was renewed: re-decide every subscription this socket holds, under the new actor. */
  onActor: (socketId: string, actor: Actor) => Promise<void>;
  /** Nobody may hold this socket any longer. The caller closes it. */
  onRevoked: (socketId: string) => void;
  /** `refresh` raised instead of deciding. The grant is kept and retried on the next pass. */
  onRefreshFailed?: (socketId: string, error: unknown) => void;
}

export interface GrantSweepResult {
  readonly refreshed: number;
  readonly revoked: number;
  readonly failed: number;
}

/**
 * One pass over the expired grants. The clock is injected because a re-auth only provable by
 * sleeping is a re-auth no test proves — the same rule the client's reconnect timer already follows.
 *
 * A `refresh` that raises keeps its grant: a denial and a failure never share an answer here either,
 * and signing every connected user out because the auth backend timed out is a bigger outage than
 * the one it would be responding to. It stays expired, so the next pass retries it — and every
 * failure is reported, because a socket that cannot be re-decided is not a socket anyone should
 * discover from a graph of connection counts.
 */
export async function sweepGrants(deps: GrantSweepDeps): Promise<GrantSweepResult> {
  const now = deps.clock.now().getTime();
  let refreshed = 0;
  let revoked = 0;
  let failed = 0;
  for (const [socketId, grant] of deps.grants.expired(now)) {
    let next: SyncGrant | null;
    try {
      next = grant.refresh ? await grant.refresh() : null;
    } catch (error) {
      failed += 1;
      deps.onRefreshFailed?.(socketId, error);
      continue;
    }
    if (next === null) {
      deps.grants.delete(socketId);
      deps.onRevoked(socketId);
      revoked += 1;
      continue;
    }
    deps.grants.set(socketId, next);
    await deps.onActor(socketId, next.actor);
    refreshed += 1;
  }
  return { refreshed, revoked, failed };
}
