// The client's liveness pass: re-announce this socket before the node forgets it, and notice a
// socket that has stopped answering. A policy (when to beat, when to give up), not a wire detail —
// which is why it is here and not inside `client.ts`'s connection lifecycle.

import type { Scheduler } from './thundering-herd';

/**
 * The client's own number, and `As of 2026-08-19` the only one. It used to be described as a
 * restatement of `realtime.heartbeatMs` in `@ultimat3/core`'s config — that key was read by
 * nothing and is deleted, so there is no second value to keep this equal to. The server side of
 * the beat is DERIVED, never configured: `PresenceRegistry.heartbeatMs` is `ttlMs / 3`.
 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

export interface HeartbeatOptions {
  /** `0` (or less) disables the pass entirely — the shape a test that owns the clock wants. */
  readonly intervalMs: number;
  readonly schedule: Scheduler;
  readonly now: () => number;
  /** Re-announces this socket. Called only while the socket is still answering. */
  readonly beat: () => void;
  /** Two windows of silence: the socket is half-open and only this client can end it. */
  readonly onSilence: () => void;
}

/**
 * One armed tick at a time, re-armed by itself. It is deliberately NOT an interval: the reconnect
 * timer is the same injected `Scheduler` seam, and a client is either beating on a live socket or
 * backing off towards a new one — never both, so one armed timer is the whole mechanism.
 */
export class Heartbeat {
  readonly #options: HeartbeatOptions;
  #cancel: (() => void) | null = null;
  #lastSeen = 0;

  constructor(options: HeartbeatOptions) {
    this.#options = options;
  }

  /** The socket is up. `now` seeds the silence window, so the first tick judges this connection. */
  start(now: number): void {
    this.stop();
    if (this.#options.intervalMs <= 0) return;
    this.#lastSeen = now;
    this.#arm();
  }

  /** A frame arrived. Anything counts: the point is that bytes still cross in this direction. */
  saw(now: number): void {
    this.#lastSeen = now;
  }

  stop(): void {
    const cancel = this.#cancel;
    this.#cancel = null;
    cancel?.();
  }

  #arm(): void {
    this.#cancel = this.#options.schedule(() => {
      this.#cancel = null;
      this.#tick();
    }, this.#options.intervalMs);
  }

  #tick(): void {
    const now = this.#options.now();
    // Two windows, not one: a beat and the answer to it share the window they were sent in, so a
    // single quiet interval is a slow round trip and not a dead socket. Nothing is re-armed after
    // a silence — `onSilence` drops the socket, and the next `start()` is the next connection's.
    if (now - this.#lastSeen > this.#options.intervalMs * 2) {
      this.#options.onSilence();
      return;
    }
    this.#options.beat();
    this.#arm();
  }
}
