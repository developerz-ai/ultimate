// One WS connection. Bun's WS profile is what makes a million sockets affordable, so this object
// is deliberately lean: ~8 fields plus two small sets. Budget is ~1KB of JS heap per connection on
// top of Bun's own per-socket cost — anything richer (row caches, per-socket buffers) belongs in
// the transport or the change buffer, never here. `sync` is stateless: nothing on this object
// survives a restart, and nothing needs to.

import { type Actor, type Clock, systemClock, uuid } from '@ultimat3/core';
import { encode, type Frame } from './sync-protocol';

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  policy: 1008,
  overloaded: 1013,
  versionSkew: 4000,
  idle: 4001,
  drain: 4002,
} as const;

/** The slice of Bun's `ServerWebSocket` this package uses. Structural, so tests need no server. */
export interface WsLike {
  send(data: string): number;
  close(code?: number, reason?: string): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  getBufferedAmount(): number;
}

export interface SyncSocketOptions {
  readonly ws: WsLike;
  /** Build id the *client* reported in `hello`. Version skew is a first-class connection state. */
  readonly clientBuildId: string;
  readonly serverBuildId: string;
  readonly actor?: Actor | null;
  readonly id?: string;
  readonly clock?: Clock;
  /** Frames are dropped rather than queued past this. See `desynced`. */
  readonly maxBufferedBytes?: number;
  readonly maxDroppedFrames?: number;
}

export function actorIdOf(actor: Actor | null): string | null {
  return actor === null ? null : actor.id;
}

export class SyncSocket {
  readonly id: string;
  readonly clientBuildId: string;
  readonly serverBuildId: string;
  readonly openedAt: number;
  /** Channel topics (tier 1). Live-query subscriptions are keyed separately, by sid. */
  readonly topics = new Set<string>();
  /** sid -> qid for live queries (tier 2/3) on this connection. */
  readonly queries = new Map<string, string>();
  /**
   * Subscriptions whose patch stream was interrupted by backpressure. Dropping a patch is safe
   * *only* because the cursor makes a re-snapshot cheap; the drop is recorded here so the next
   * flush re-snapshots instead of silently diverging.
   */
  readonly desynced = new Set<string>();

  actor: Actor | null;
  lastSeenAt: number;
  droppedFrames = 0;
  sentFrames = 0;

  readonly #ws: WsLike;
  readonly #clock: Clock;
  readonly #maxBufferedBytes: number;
  readonly #maxDroppedFrames: number;
  #closed = false;

  constructor(options: SyncSocketOptions) {
    this.#ws = options.ws;
    this.#clock = options.clock ?? systemClock;
    this.id = options.id ?? uuid();
    this.clientBuildId = options.clientBuildId;
    this.serverBuildId = options.serverBuildId;
    this.actor = options.actor ?? null;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
    this.#maxDroppedFrames = options.maxDroppedFrames ?? 32;
    this.openedAt = this.#clock.now().getTime();
    this.lastSeenAt = this.openedAt;
  }

  get actorId(): string | null {
    return actorIdOf(this.actor);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** A skewed client gets an `update-available` frame; it is never silently served a new shape. */
  get skewed(): boolean {
    return this.clientBuildId !== this.serverBuildId;
  }

  /** `false` means the frame was dropped by backpressure — the caller must mark state stale. */
  send(frame: Frame): boolean {
    if (this.#closed) return false;
    if (this.#ws.getBufferedAmount() > this.#maxBufferedBytes) {
      this.droppedFrames += 1;
      if (this.droppedFrames > this.#maxDroppedFrames) {
        this.close(CLOSE.overloaded, 'backpressure');
      }
      return false;
    }
    this.#ws.send(encode(frame));
    this.sentFrames += 1;
    return true;
  }

  /** Record a dropped or invalidated subscription so the next flush re-snapshots it. */
  markDesynced(sid: string): void {
    this.desynced.add(sid);
  }

  clearDesynced(sid: string): void {
    this.desynced.delete(sid);
  }

  subscribeTopic(topic: string): void {
    this.topics.add(topic);
    this.#ws.subscribe(topic);
  }

  unsubscribeTopic(topic: string): void {
    this.topics.delete(topic);
    this.#ws.unsubscribe(topic);
  }

  touch(): void {
    this.lastSeenAt = this.#clock.now().getTime();
  }

  idleFor(now: number): number {
    return now - this.lastSeenAt;
  }

  close(code: number = CLOSE.normal, reason = ''): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ws.close(code, reason);
  }
}

export interface SocketRegistryOptions {
  readonly clock?: Clock;
  /** Bun also enforces its own `idleTimeout`; this sweep catches half-open connections. */
  readonly idleTimeoutMs?: number;
}

/** Per-node socket table. Intentionally the only in-memory map on a `sync` node. */
export class SocketRegistry {
  readonly #sockets = new Map<string, SyncSocket>();
  readonly #clock: Clock;
  readonly #idleTimeoutMs: number;

  constructor(options: SocketRegistryOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  }

  add(socket: SyncSocket): void {
    this.#sockets.set(socket.id, socket);
  }

  remove(id: string): void {
    this.#sockets.delete(id);
  }

  get(id: string): SyncSocket | undefined {
    return this.#sockets.get(id);
  }

  all(): Iterable<SyncSocket> {
    return this.#sockets.values();
  }

  get count(): number {
    return this.#sockets.size;
  }

  /** Closes and returns everything past the idle budget. Called on an interval by `sync-node`. */
  sweepIdle(): SyncSocket[] {
    const now = this.#clock.now().getTime();
    const closed: SyncSocket[] = [];
    for (const socket of this.#sockets.values()) {
      if (socket.idleFor(now) > this.#idleTimeoutMs) {
        socket.close(CLOSE.idle, 'idle timeout');
        this.#sockets.delete(socket.id);
        closed.push(socket);
      }
    }
    return closed;
  }

  /** Local delivery for a channel topic. Bun's native pub/sub handles the common case; this is
   *  the fallback used when a frame must be filtered per socket (policy, desync bookkeeping). */
  deliver(topic: string, frame: Frame): number {
    let sent = 0;
    for (const socket of this.#sockets.values()) {
      if (socket.topics.has(topic) && socket.send(frame)) sent += 1;
    }
    return sent;
  }
}
