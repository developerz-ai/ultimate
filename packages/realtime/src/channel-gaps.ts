// The repair half of a dropped `records` frame: the per-socket mark is `SyncSocket.gaps`, and this
// is what answers it — one `replay-gap` per (socket, topic), sent once the socket takes frames
// again, counted in `channel_replay_gaps_total` beside `channel_frames_dropped_total` (declared
// here too; `socket.ts` counts the drops).

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

/**
 * Channel frames this process dropped under backpressure. A dropped `records` frame is now marked
 * and REPAIRED — the socket is sent `replay-gap` once it drains and re-reads the channel's catch-up
 * query (`channel_replay_gaps_total` counts those) — while a dropped `events` frame is ephemeral
 * by definition and is only counted. The two series side by side are the whole delivery story.
 *
 * Declared here rather than in `@ultimat3/core`'s `runtime-metrics.ts` because that file is the
 * series EVERY Ultimate process emits and the deploy chart scales on; this one exists only where
 * channels do. **No attributes**: a topic is client-chosen (`topic()` admits any
 * `[A-Za-z0-9_-]+` segment), so a per-topic label is an unbounded series count one socket can mint
 * — the topic goes in the log line, where cardinality is somebody else's index.
 */
export const channelFramesDropped: Counter = counter('channel_frames_dropped_total', {
  unit: '{frame}',
  description: 'Channel frames dropped by socket backpressure',
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
