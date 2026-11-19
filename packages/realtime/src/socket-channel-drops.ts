// The node-wide series for channel frames socket backpressure refused. Split from `socket.ts`, which
// counts the drops at the one place they happen; this is only the series' declaration.

import { type Counter, counter } from '@ultimat3/core';

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
