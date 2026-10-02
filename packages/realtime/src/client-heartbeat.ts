// The client's liveness pass: re-announce this socket before the node forgets it, and notice a
// socket that has stopped answering. A policy (when to beat, when to give up), not a wire detail —
// which is why it is here and not inside `client.ts`'s connection lifecycle.

import type { Scheduler } from './thundering-herd';

/**
 * A third of the node's default presence ttl (`DEFAULT_PRESENCE_TTL_MS`, 30 s), which is what the
 * node derives for itself (`PresenceRegistry.heartbeatMs` is `ttlMs / 3`): two beats land inside
 * every ttl, so ONE lost beat is never a false leave. It was 15 s — half the ttl, where the beat
 * after a lost one lands on the expiry itself. `client-heartbeat.test.ts` holds the two equal;
 * this file cannot import the server's constant (`transport-env.ts` links `nats`).
 */
export const DEFAULT_HEARTBEAT_MS = 10_000;

/** The node floors the beat it names at 1 s (`clientHeartbeatMs`); less than that is not its word. */
export const MIN_HEARTBEAT_MS = 1_000;

export interface HeartbeatOptions {
  /**
   * Until the node names its own (`follow`). `0` (or less) disables the pass entirely, whatever
   * the node says — the shape a test that owns the clock wants.
   */
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
  /** The beat in force on THIS socket: the option's, until the node's `hello` names another. */
  #intervalMs: number;

  constructor(options: HeartbeatOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  /** The socket is up. `now` seeds the silence window, so the first tick judges this connection. */
  start(now: number): void {
    this.stop();
    // A new socket may be another node's: its beat is not known until its `hello` says so.
    this.#intervalMs = this.#options.intervalMs;
    if (this.#intervalMs <= 0) return;
    this.#lastSeen = now;
    this.#arm();
  }

  /**
   * The node named the beat (`hello.heartbeatMs`): a third of ITS presence ttl, bounded by ITS idle
   * budget — two numbers a browser cannot read, and the reason a fixed client beat was wrong for
   * every app that set either. Re-armed at once, so a shorter beat does not wait out the long one.
   */
  follow(intervalMs: number): void {
    if (this.#options.intervalMs <= 0) return;
    if (intervalMs < MIN_HEARTBEAT_MS || intervalMs === this.#intervalMs) return;
    this.#intervalMs = intervalMs;
    if (this.#cancel === null) return;
    this.stop();
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
    }, this.#intervalMs);
  }

  #tick(): void {
    const now = this.#options.now();
    // Two windows, not one: a beat and the answer to it share the window they were sent in, so a
    // single quiet interval is a slow round trip and not a dead socket. Nothing is re-armed after
    // a silence — `onSilence` drops the socket, and the next `start()` is the next connection's.
    if (now - this.#lastSeen > this.#intervalMs * 2) {
      this.#options.onSilence();
      return;
    }
    this.#options.beat();
    this.#arm();
  }
}
