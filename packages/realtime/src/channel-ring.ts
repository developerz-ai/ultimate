// One channel topic's record log on THIS node: the epoch, the next seq, and a bounded ring of the
// last frames' contents so a resubscribe `since` a recent seq replays instead of re-reading.
// Seq is minted here — at the delivering node — because a records frame never crosses the bus.

import { finiteOption, type Row } from '@ultimat3/core';
import type { ChannelSince } from './channel-wire';

/** One committed change on one topic, before it is rendered for a particular socket. */
export interface RecordsEntry {
  readonly seq: number;
  readonly adopt: readonly RecordPart[];
  readonly remove: readonly { readonly type: string; readonly key: string }[];
  /** The write that produced the change (`ChangeEvent.write`), kept so a replay still names it. */
  readonly write?: string;
}

export interface RecordPart {
  readonly type: string;
  readonly key: string;
  readonly row: Row;
}

/** Frames a ring keeps per topic. A resume further back than this is answered `replay-gap`. */
export const DEFAULT_CHANNEL_RING = 256;

export class ChannelRing {
  /**
   * New per ring, never per hub: a topic whose last subscriber left drops its ring, and the next
   * one restarts seq at 1 — under the SAME epoch a client resuming `since: 50` would read seq 1..49
   * as duplicates and silently drop them. A fresh epoch makes that a reset instead.
   */
  readonly epoch: string;
  readonly #capacity: number;
  readonly #entries: RecordsEntry[] = [];
  #seq = 0;

  constructor(epoch: string, capacity: number = DEFAULT_CHANNEL_RING) {
    this.epoch = epoch;
    this.#capacity = finiteOption('ChannelRing', 'capacity', capacity);
  }

  /** The seq the last `append` minted; 0 before the first. */
  get seq(): number {
    return this.#seq;
  }

  append(
    adopt: readonly RecordPart[],
    remove: RecordsEntry['remove'],
    write?: string,
  ): RecordsEntry {
    this.#seq += 1;
    const entry: RecordsEntry = {
      seq: this.#seq,
      adopt,
      remove,
      ...(write === undefined ? {} : { write }),
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) this.#entries.shift();
    return entry;
  }

  /**
   * Every entry after `since.seq`, oldest first — or `null` when the ring cannot prove it holds
   * all of them: another epoch, a seq from the future, or one older than the ring's oldest.
   */
  since(since: ChannelSince): readonly RecordsEntry[] | null {
    if (since.epoch !== this.epoch || since.seq > this.#seq || since.seq < 0) return null;
    if (since.seq === this.#seq) return [];
    const oldest = this.#entries[0];
    if (oldest === undefined || oldest.seq > since.seq + 1) return null;
    return this.#entries.filter((entry) => entry.seq > since.seq);
  }
}
