// Every declared channel topic this node delivers records on: its ring (epoch, seq, recent frames),
// the change → frame path, and the resume a resubscribe `since` asks for. One per `ChannelHub`.
// Records never cross the bus — each node reads every change itself — so seq is minted here.

import { logger, renderThrowable, uuid } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import type { Channel } from './channel-decl';
import { updatesFor } from './channel-records';
import { renderRecords } from './channel-render';
import { ChannelRing } from './channel-ring';
import type { ChannelSince, ReplayGapFrame } from './channel-wire';
import type { SocketRegistry, SyncSocket } from './socket';
import { PROTOCOL_VERSION } from './sync-protocol';

/** What a joined topic resolves to. A topic is `name.params…`, so it names both exactly. */
export interface ChannelTopic {
  readonly channel: Channel;
  readonly params: Readonly<Record<string, string>>;
}

export class ChannelLogs {
  readonly #sockets: SocketRegistry;
  readonly #ringSize: number | undefined;
  /** This hub's mark on every epoch it mints: a restarted node can never reuse one. */
  readonly #hubId = uuid();
  #rings = 0;
  readonly #byTopic = new Map<
    string,
    { readonly ring: ChannelRing; readonly target: ChannelTopic }
  >();

  constructor(sockets: SocketRegistry, ringSize?: number) {
    this.#sockets = sockets;
    this.#ringSize = ringSize;
  }

  /** The topic's log, opened on its first local member. */
  open(topic: string, target: ChannelTopic): ChannelRing {
    const existing = this.#byTopic.get(topic);
    if (existing !== undefined) return existing.ring;
    this.#rings += 1;
    const ring = new ChannelRing(`${this.#hubId}:${this.#rings}`, this.#ringSize);
    this.#byTopic.set(topic, { ring, target });
    return ring;
  }

  /** Dropped with the topic's last local member; the next member gets a new epoch. */
  close(topic: string): void {
    this.#byTopic.delete(topic);
  }

  target(topic: string): ChannelTopic | undefined {
    return this.#byTopic.get(topic)?.target;
  }

  /**
   * One committed change → a `records` frame on every open topic it touches, rendered per socket.
   * A key that cannot be computed (`X_RECORD_KEY_MISSING`) is logged and skipped for that channel:
   * the change is somebody else's too, and one malformed image must not stop the rest.
   */
  deliverChange(channels: Iterable<Channel>, change: ChangeEvent): number {
    let frames = 0;
    let updates: ReturnType<typeof updatesFor>;
    try {
      updates = updatesFor(channels, change);
    } catch (error) {
      logger.warn('channel.records_unkeyed', {
        table: change.entity,
        error: renderThrowable(error),
      });
      return 0;
    }
    for (const update of updates) {
      const open = this.#byTopic.get(update.topic);
      if (open === undefined) continue;
      const entry = open.ring.append(update.adopt, update.remove, change.write);
      const frame = renderRecords(update.topic, open.ring.epoch, entry);
      frames += this.#sockets.deliverRecords(update.topic, open.ring.epoch, frame);
    }
    return frames;
  }

  /**
   * A (re)subscribe `since` a position: every frame after it from the ring, or — when the ring
   * cannot prove it holds them all, or the epoch moved — one `replay-gap`.
   *
   * A FRESH seat with no `since` is a `replay-gap` too. The client's first read of these rows went
   * over HTTP, on another connection, before this seat existed, so a commit between the two
   * reached nobody — and nothing the client holds can name it. The seat is the one point after
   * which every commit is a frame, so the re-read is told to start from here. A repeated `add` on
   * a socket already seated (the presence beat), or a channel with no records, is sent nothing.
   */
  resume(socket: SyncSocket, topic: string, since: ChannelSince | undefined, fresh: boolean): void {
    const open = this.#byTopic.get(topic);
    if (open === undefined) return;
    // An events-only channel (typing, a cursor) carries no rows, so there is nothing to re-read.
    if (since === undefined && (!fresh || open.target.channel.records.length === 0)) return;
    const entries = since === undefined ? null : open.ring.since(since);
    if (entries === null) {
      const frame: ReplayGapFrame = {
        type: 'replay-gap',
        v: PROTOCOL_VERSION,
        channel: topic,
        epoch: open.ring.epoch,
      };
      if (!socket.send(frame)) socket.gaps.set(topic, open.ring.epoch);
      return;
    }
    for (const entry of entries) {
      if (!socket.send(renderRecords(topic, open.ring.epoch, entry))) {
        socket.gaps.set(topic, open.ring.epoch);
        return;
      }
    }
  }
}
