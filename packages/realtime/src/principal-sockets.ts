// One principal's open sockets on this node, counted so the upgrade can refuse the next one. The
// per-actor SUBSCRIPTION cap bounds what a principal holds; this bounds how many sockets it holds it
// across — each one a grant, a frame budget, a heartbeat and a slot of `maxConnections`.

import { ConfigInvalidError } from '@ultimat3/core';

/**
 * Sixteen sockets at the per-socket 128 subscriptions is 2,048 — past the per-actor 1,000, so a
 * legitimate principal's tabs never hit this before they hit the subscription cap, while one
 * principal can no longer take a node's `maxConnections` for itself.
 */
export const DEFAULT_MAX_SOCKETS_PER_ACTOR = 16;

/**
 * An ANONYMOUS principal is a network, not a person: an office behind one corporate NAT viewing a
 * public live page is one `address:` key, and held to an actor's 16 it was 16 sockets for the whole
 * floor. A network gets this many actors' worth — 128 at the default — while a signed-in actor keeps
 * `maxSocketsPerActor`. The subscription cap is not multiplied.
 */
export const ANONYMOUS_SOCKET_MULTIPLIER = 8;

const isNetwork = (principal: string): boolean => principal.startsWith('address:');

/** A COUNT of at least 1, refused as the config key of the same name is. */
function socketCeiling(value: number | undefined): number {
  const max = value ?? DEFAULT_MAX_SOCKETS_PER_ACTOR;
  if (Number.isSafeInteger(max) && max >= 1) return max;
  throw new ConfigInvalidError({
    cause: `maxSocketsPerActor (realtime.maxSocketsPerActor) must be a whole number of at least 1, not ${String(max)} — 0 refuses every upgrade, and a fraction or a NaN is a cap no count ever reaches`,
    fix: `createSyncNode({ maxSocketsPerActor: ${String(DEFAULT_MAX_SOCKETS_PER_ACTOR)} })   # or realtime: { maxSocketsPerActor: ${String(DEFAULT_MAX_SOCKETS_PER_ACTOR)} } in app.config.ts`,
    meta: { key: 'realtime.maxSocketsPerActor', value: max },
  });
}

/**
 * Taken at the upgrade — synchronously, right before `server.upgrade`, so a herd parked in
 * `authenticate` cannot all pass one count — and given back on EVERY path a socket ends: its
 * close, and an upgrade that threw or declined after the slot was taken. `release` is idempotent.
 */
export class PrincipalSockets {
  readonly max: number;
  readonly #bySocket = new Map<string, string>();
  readonly #count = new Map<string, number>();

  constructor(max: number | undefined) {
    this.max = socketCeiling(max);
  }

  /** Admit `socketId` under `principal`, or `false` when that principal is at its cap. */
  admit(socketId: string, principal: string): boolean {
    const held = this.#count.get(principal) ?? 0;
    if (held >= this.limitFor(principal)) return false;
    this.#bySocket.set(socketId, principal);
    this.#count.set(principal, held + 1);
    return true;
  }

  /** The cap `principal` is held to: `max` for an actor, `max × 8` for an anonymous network. */
  limitFor(principal: string): number {
    return isNetwork(principal) ? this.max * ANONYMOUS_SOCKET_MULTIPLIER : this.max;
  }

  release(socketId: string): void {
    const principal = this.#bySocket.get(socketId);
    if (principal === undefined) return;
    this.#bySocket.delete(socketId);
    const next = (this.#count.get(principal) ?? 0) - 1;
    if (next > 0) this.#count.set(principal, next);
    else this.#count.delete(principal);
  }

  count(principal: string): number {
    return this.#count.get(principal) ?? 0;
  }
}
