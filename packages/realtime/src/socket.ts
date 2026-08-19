// One WS connection. Bun's WS profile is what makes a million sockets affordable, so this object
// is deliberately lean: ~8 fields, two small sets and one token bucket (the frame budget, which is
// five numbers and the only thing standing between one authenticated socket and this node's whole
// subscribe path). Budget is ~1KB of JS heap per connection on top of Bun's own per-socket cost —
// anything richer (row caches, per-socket buffers) belongs in the transport or the change buffer,
// never here. `sync` is stateless: nothing on this object survives a restart, and nothing needs to.

import {
  type Actor,
  type Clock,
  type Counter,
  counter,
  logger,
  recordConnection,
  systemClock,
  uuid,
} from '@ultimat3/core';
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

/**
 * The slice of Bun's `ServerWebSocket` this package uses. Structural, so tests need no server.
 *
 * `subscribe`/`unsubscribe` are Bun's native pub/sub and this package does NOT use them: nothing
 * here publishes to a native topic, and nothing will — a native publish cannot be refused per
 * socket, cannot report the frame it dropped and cannot mark a subscriber desynced, which is
 * exactly what `SocketRegistry.deliver` and `SyncSocket.send` exist to do. They are still declared
 * because `WsLike` is the slice of Bun's own object, and an app already implements it; deleting
 * them is a separate, breaking edit to every implementer.
 */
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
/**
 * Queued-but-unwritten bytes on one server socket before `send` declines and marks the subscriber
 * desynced. `sync-node.ts` hands the same number to Bun as `backpressureLimit` rather than spelling
 * it again: they are one socket's one buffer, and a check the runtime's own limit fires before is a
 * check that never runs. The client half (`client-mutations.ts`) is deliberately its own constant —
 * it is browser code, and importing this file would pull the node's socket registry into the tab.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Channel frames this process dropped under backpressure. A DATA-LOSS counter, not a saturation
 * one: the live-query path repairs a dropped patch (the subscriber is marked desynced and the next
 * change re-snapshots it), and a channel has no cursor, no mark and no re-snapshot — so this is the
 * only trace a lost channel message leaves anywhere.
 *
 * Declared here rather than in `@ultimat3/core`'s `runtime-metrics.ts` because that file is the
 * series EVERY Ultimate process emits and the deploy chart scales on; this one exists only where
 * channels do. **No attributes**: a topic is client-chosen (`topic()` admits any
 * `[A-Za-z0-9_-]+` segment), so a per-topic label is an unbounded series count one socket can mint
 * — the topic goes in the log line, where cardinality is somebody else's index.
 */
const channelFramesDropped: Counter = counter('channel_frames_dropped_total', {
  unit: '{frame}',
  description: 'Channel frames dropped by socket backpressure — unrecoverable, nothing replays one',
});

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
    this.#maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
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

  /**
   * This socket's own membership, and nothing else. It used to also call Bun's `ws.subscribe`,
   * which built a second per-topic index nothing ever published to — the fanout is
   * `SocketRegistry.deliver`, one filtered `send` per socket, because that is the only path that
   * can count a dropped frame or close a socket that is drowning in them.
   */
  subscribeTopic(topic: string): void {
    this.topics.add(topic);
  }

  unsubscribeTopic(topic: string): void {
    this.topics.delete(topic);
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

/**
 * How long a socket may route no frame before `sync-node` evicts it. It is an APPLICATION
 * inactivity budget and not Bun's transport one: Bun's `idleTimeout` is renewed by its own
 * ping/pong, so a client whose TCP stack still answers pings while its frame loop is wedged holds
 * its grant, its subscriptions and its topic membership forever. A beating client sends a `hello`
 * every `DEFAULT_HEARTBEAT_MS` (15s), so this is eight missed beats.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * How often to ask. A quarter of the budget, floored at a second: a socket is evicted within 25%
 * of its window of going quiet, and a node holding 50,000 of them pays one pass over the table
 * four times per window rather than once a second. Derived rather than configured — a second knob
 * is a second number that can disagree with the one it is a fraction of.
 */
export function idleSweepPeriodMs(idleTimeoutMs: number): number {
  return Math.max(1_000, Math.floor(idleTimeoutMs / 4));
}

export interface SocketRegistryOptions {
  readonly clock?: Clock;
  /** Bun's own `idleTimeout` is renewed by its ping/pong; this budget counts routed FRAMES. */
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
  #droppedChannelFrames = 0;

  constructor(options: SocketRegistryOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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
    if (!socket) return;
    // Leaving this table IS the close, whoever noticed first. Bun's `close` callback reports a
    // connection that has already gone, so nothing called `close()` on this object and
    // `socket.closed` stayed false — leaving a subscribe still awaiting its snapshot read with no
    // way to tell that the socket it is about to attach to was torn down while it read.
    socket.close(CLOSE.goingAway, 'connection closed');
    for (const name of socket.topics) this.#dropFrom(name, socket);
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

  /** The budget `idle()` answers against, so a caller can size its own sweep from one number. */
  get idleTimeoutMs(): number {
    return this.#idleTimeoutMs;
  }

  /**
   * Everything past the idle budget. A QUERY, and deliberately not an eviction: this table is three
   * of the five things a socket holds, and the other two — its live subscriptions and its presence
   * membership on the SHARED set — are only reachable from `sync-node`'s `teardown`. A sweep that
   * closed and `remove`d here left a member every other node renders until its TTL and a
   * `QueryEntry` whose `subscribers` map never empties. `sync-node` is the one caller and it
   * releases each one the way the close callback does.
   */
  idle(): SyncSocket[] {
    const now = this.#clock.now().getTime();
    return [...this.#sockets.values()].filter(
      (socket) => socket.idleFor(now) > this.#idleTimeoutMs,
    );
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
    let dropped = 0;
    for (const socket of members) {
      if (socket.closed) {
        members.delete(socket);
        continue;
      }
      if (socket.send(frame)) sent += 1;
      else dropped += 1;
    }
    if (members.size === 0) this.#byTopic.delete(topic);
    if (dropped > 0) {
      this.#droppedChannelFrames += dropped;
      // Two readers, one event, one spelling: the series an operator alerts on and the line that
      // says which topic it was. `deliver` ignored `send`'s answer and so did the hub above it, so
      // until both existed a lost channel message left no trace at all.
      channelFramesDropped.add(dropped);
      logger.warn('channel.frames_dropped', { topic, dropped, total: this.#droppedChannelFrames });
    }
    return sent;
  }

  /**
   * Channel frames backpressure refused since boot, node-wide and cumulative — the in-process read
   * of `channel_frames_dropped_total`, for a test or a benchmark that cannot scrape.
   *
   * Node-wide on purpose: a socket past `maxDroppedFrames` is closed and removed, so a per-socket
   * count leaves with the socket exactly when loss is worst. Distinct from `SyncSocket.droppedFrames`,
   * which counts every kind of frame one connection lost, channel and live-query patch alike.
   */
  get droppedChannelFrames(): number {
    return this.#droppedChannelFrames;
  }

  #dropFrom(topic: string, socket: SyncSocket): void {
    const members = this.#byTopic.get(topic);
    if (!members) return;
    members.delete(socket);
    if (members.size === 0) this.#byTopic.delete(topic);
  }
}
