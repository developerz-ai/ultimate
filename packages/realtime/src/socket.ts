// One WS connection. Bun's WS profile is what makes a million sockets affordable, so this object
// is deliberately lean: ~8 fields, two small sets and one token bucket (the frame budget, which is
// five numbers and the only thing standing between one authenticated socket and this node's whole
// subscribe path). Budget is ~1KB of JS heap per connection on top of Bun's own per-socket cost —
// anything richer (row caches, per-socket buffers) belongs in the transport or the change buffer,
// never here. `sync` is stateless: nothing on this object survives a restart, and nothing needs to.

import { type Actor, type Clock, recordConnection, systemClock, uuid } from '@ultimat3/core';
import { encode, type Frame } from './sync-protocol';
import { AcceptBudget } from './thundering-herd';

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
  /** Sustained inbound frames this socket may have routed per second. See `frameBudget`. */
  readonly maxFramesPerSecond?: number;
  /** Burst allowance, so a client subscribing its whole cap at connect is never refused. */
  readonly frameBurst?: number;
}

/**
 * What one socket may ask this node to do per second, and how much of it may arrive at once.
 *
 * The burst clears `DEFAULT_MAX_PER_SOCKET` (128) plus a `hello`, because that is exactly what a
 * legitimate client sends on connect; the sustained rate is well under the ~155 frames/s measured
 * to consume a node through the subscribe path's amplifiers.
 */
export const DEFAULT_MAX_FRAMES_PER_SECOND = 64;
export const DEFAULT_FRAME_BURST = 256;

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
  /**
   * Inbound frames this socket may still have routed. The accept budget spends one token per
   * UPGRADE, so nothing bounded what happened after: one authenticated socket reached a DB read,
   * a shared-store presence write and a fleet-wide publish once per frame, unbounded and
   * unawaited. Same token bucket, one per socket — the mechanism already existed, one rung down.
   */
  readonly frameBudget: AcceptBudget;

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
    this.frameBudget = new AcceptBudget({
      perSecond: options.maxFramesPerSecond ?? DEFAULT_MAX_FRAMES_PER_SECOND,
      burst: options.frameBurst ?? DEFAULT_FRAME_BURST,
      clock: this.#clock,
    });
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
  /**
   * Who is on each channel topic. `deliver` walked every socket on the node asking each whether
   * it held the topic, so one message with one legitimate subscriber cost as many iterations as
   * this node has connections — 50,000 at the scale this framework benchmarks. It lives here
   * rather than on the hub because this is the only object that sees a socket die: a close, a
   * drain and the idle sweep all pass through `remove`, and an index nobody cleans on those paths
   * retains a dead socket per topic forever.
   */
  readonly #byTopic = new Map<string, Set<SyncSocket>>();
  readonly #clock: Clock;
  readonly #idleTimeoutMs: number;

  constructor(options: SocketRegistryOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  }

  /**
   * This package's ONE metrics call site, and it is here rather than in `sync-node.ts` because
   * this map is the only definition of "a live connection on this node": a socket ends on the WS
   * close callback, on the idle sweep, on the drain and on a duplicate id, and every one of those
   * paths already had to come through `add`/`remove`. A gauge moved from the callers instead would
   * leak on whichever path a later change forgets — and a connections gauge that only counts up is
   * an HPA that only scales up.
   */
  add(socket: SyncSocket): void {
    const replacing = this.#sockets.has(socket.id);
    this.#sockets.set(socket.id, socket);
    // A re-added id replaces one connection with another; the count did not change.
    if (!replacing) recordConnection(1);
  }

  remove(id: string): void {
    const socket = this.#sockets.get(id);
    // `Map.delete` answers "was it actually there", so a double close cannot decrement twice.
    if (!this.#sockets.delete(id)) return;
    recordConnection(-1);
    if (socket) for (const name of socket.topics) this.#dropFrom(name, socket);
  }

  /**
   * Join a topic: the socket's own set, Bun's native pub/sub and this node's delivery index, in
   * one call. `ChannelHub` is its only caller, and calls nothing else — two call sites for one
   * membership is how an index goes wrong.
   */
  joinTopic(socket: SyncSocket, topic: string): void {
    socket.subscribeTopic(topic);
    const members = this.#byTopic.get(topic);
    if (members) members.add(socket);
    else this.#byTopic.set(topic, new Set([socket]));
  }

  leaveTopic(socket: SyncSocket, topic: string): void {
    socket.unsubscribeTopic(topic);
    this.#dropFrom(topic, socket);
  }

  /** Sockets this node would deliver `topic` to. */
  subscriberCount(topic: string): number {
    return this.#byTopic.get(topic)?.size ?? 0;
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
        // Through `remove`, not the map: the sweep is exactly the abnormal close a gauge leaks on.
        this.remove(socket.id);
        closed.push(socket);
      }
    }
    return closed;
  }

  /**
   * Local delivery for a channel topic — every channel message on this node comes through here,
   * so it reads the per-topic index rather than the socket table. A socket that closed without
   * an unsubscribe is dropped as it is met, so the index cannot outlive the connection even on a
   * path that forgot to `remove` it.
   */
  deliver(topic: string, frame: Frame): number {
    const members = this.#byTopic.get(topic);
    if (!members) return 0;
    let sent = 0;
    for (const socket of members) {
      if (socket.closed) {
        members.delete(socket);
        continue;
      }
      if (socket.send(frame)) sent += 1;
    }
    if (members.size === 0) this.#byTopic.delete(topic);
    return sent;
  }

  #dropFrom(topic: string, socket: SyncSocket): void {
    const members = this.#byTopic.get(topic);
    if (!members) return;
    members.delete(socket);
    if (members.size === 0) this.#byTopic.delete(topic);
  }
}
