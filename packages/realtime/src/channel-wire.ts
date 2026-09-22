// The three channel frames a node sends, and the subscribe target a client sends — browser-safe
// types, members of `sync-protocol.ts`'s `Frame` union since protocol 3. `records` writes the page's store; `events` never does; `replay-gap` is the server's
// verdict that this socket lost a `records` frame and must re-read the channel's catch-up query.

import type { Row } from '@ultimat3/core/page';
import type { JsonObject } from './json';

/** Where a resubscribe resumes: the last `records` frame the client applied on this channel. */
export interface ChannelSince {
  readonly epoch: string;
  readonly seq: number;
}

/** `subscribe.target` for a declared channel. `channel` is the declaration NAME, never a topic. */
export interface ChannelSubscribeTarget {
  readonly kind: 'channel';
  readonly channel: string;
  readonly params: Readonly<Record<string, string>>;
  readonly since?: ChannelSince;
}

/** type → record key → row: the same keyed shape as core's `RecordEnvelope.records`. */
export type ChannelAdopt = Readonly<Record<string, Readonly<Record<string, Row>>>>;
/** type → record keys to drop. */
export type ChannelRemove = Readonly<Record<string, readonly string[]>>;

/**
 * One committed change on one channel. `channel` is the TOPIC (`name.param1.param2`), which the
 * client derives from the same declaration. `seq` counts up by one per frame within `epoch`; a
 * numeric hole is NOT a gap (a row the socket may not see is skipped for that socket) — only
 * `replay-gap` is.
 */
export interface ChannelRecordsFrame {
  readonly type: 'records';
  readonly v: number;
  readonly channel: string;
  readonly seq: number;
  readonly epoch: string;
  readonly adopt?: ChannelAdopt;
  readonly remove?: ChannelRemove;
}

/** Ephemeral (typing, a cursor, a toast). No seq, never written to the store, never replayed. */
export interface ChannelEventsFrame {
  readonly type: 'events';
  readonly v: number;
  readonly channel: string;
  readonly event: JsonObject;
}

/** "Your copy of this channel is wrong since `epoch`": re-run its catch-up read, then resume. */
export interface ReplayGapFrame {
  readonly type: 'replay-gap';
  readonly v: number;
  readonly channel: string;
  readonly epoch: string;
}

export type ChannelWireFrame = ChannelRecordsFrame | ChannelEventsFrame | ReplayGapFrame;
