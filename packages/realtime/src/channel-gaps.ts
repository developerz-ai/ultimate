// The repair half of a dropped `records` frame: the per-socket mark is `SyncSocket.gaps`, and this
// is what answers it — one `replay-gap` per (socket, topic), sent once the socket takes frames
// again, counted in `channel_replay_gaps_total` beside `channel_frames_dropped_total`.

import { type Counter, counter } from '@ultimat3/core';
import type { ReplayGapFrame } from './channel-wire';
import type { SyncSocket } from './socket';
import { PROTOCOL_VERSION } from './sync-protocol';

/**
 * `replay-gap` frames this node ANNOUNCED — a socket took the frame. Not "repaired": the re-read
 * is the client's, and a node can only count what it said, never what a browser did about it.
 */
const channelReplayGaps: Counter = counter('channel_replay_gaps_total', {
  unit: '{gap}',
  description: 'replay-gap frames delivered to a socket that lost a channel records frame',
});

export class GapRepairs {
  #announced = 0;

  /** `replay-gap` frames delivered since boot — the in-process read of the series above. */
  get announced(): number {
    return this.#announced;
  }

  /** Sends the one `replay-gap` this socket owes for `topic`, if any. `true` when one went out. */
  repair(socket: SyncSocket, topic: string): boolean {
    const epoch = socket.gaps.get(topic);
    if (epoch === undefined) return false;
    const frame: ReplayGapFrame = {
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: topic,
      epoch,
    };
    if (!socket.send(frame)) return false;
    socket.gaps.delete(topic);
    this.#announced += 1;
    channelReplayGaps.add(1);
    return true;
  }

  /** Everything this socket is owed — for Bun's `drain` callback. Answers how many went out. */
  repairAll(socket: SyncSocket): number {
    let repaired = 0;
    for (const topic of [...socket.gaps.keys()]) if (this.repair(socket, topic)) repaired += 1;
    return repaired;
  }

  /** Marks not yet answered, across `sockets`. Zero is a node owing no repair. */
  pending(sockets: Iterable<SyncSocket>): number {
    let pending = 0;
    for (const socket of sockets) pending += socket.gaps.size;
    return pending;
  }
}
