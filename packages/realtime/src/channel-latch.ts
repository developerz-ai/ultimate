// The denials one socket has been answered with, latched until its session changes — so a client
// re-asking in a loop is answered without re-running the policy, and only THAT topic is refused.
// Bounded: a topic is spelled from client params, so an unbounded latch was one entry per refusal.

import { SubscriptionLimitError } from './errors';
import type { SyncSocket } from './socket';

export class DenialLatch {
  /** Weakly keyed, so a socket's latch dies with it and no close path has to remember it. */
  readonly #bySocket = new WeakMap<SyncSocket, Set<string>>();
  readonly #max: number;
  readonly #knob: string;

  constructor(max: number, knob: string) {
    this.#max = max;
    this.#knob = knob;
  }

  has(socket: SyncSocket, name: string): boolean {
    return this.#bySocket.get(socket)?.has(name) === true;
  }

  /**
   * Refused BEFORE a policy runs once the latch is full: a socket that has been denied this many
   * distinct topics is asking for more than it may hold, and each further ask would otherwise be
   * either a retained entry or a policy pass the client schedules at will.
   */
  assertRoom(socket: SyncSocket): void {
    if ((this.#bySocket.get(socket)?.size ?? 0) < this.#max) return;
    throw new SubscriptionLimitError({
      scope: 'socket',
      id: socket.id,
      limit: this.#max,
      knob: this.#knob,
    });
  }

  add(socket: SyncSocket, name: string): void {
    const latched = this.#bySocket.get(socket) ?? new Set<string>();
    if (latched.size < this.#max) this.#bySocket.set(socket, latched.add(name));
  }

  /** A new session re-decides everything. */
  clear(socket: SyncSocket): void {
    this.#bySocket.delete(socket);
  }

  /** Denials held for one socket — what a test bounds. */
  count(socket: SyncSocket): number {
    return this.#bySocket.get(socket)?.size ?? 0;
  }
}
