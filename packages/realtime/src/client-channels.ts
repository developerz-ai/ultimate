// The client's declared channels: one membership per topic however many components hold it, the
// per-channel cursor that decides duplicate from new, and the catch-up read a `replay-gap` or a
// new epoch triggers. `records` frames go to the store and nowhere else; `events` go to handlers.

import { type PresenceEvent, readPresence } from './channel-presence';
import type { JsonObject } from './json';
import type { RecordStore } from './record-store';
import type {
  ChannelEventsFrame,
  ChannelRecordsFrame,
  ReplayGapFrame,
  SubscribeFrame,
} from './sync-protocol';
import { PROTOCOL_VERSION } from './wire-version';

/** What a browser needs of a `channel()` declaration: its name, its topic rule, its catch-up read. */
export interface ChannelRef<K extends string = string> {
  readonly name: string;
  readonly catchUp: string;
  topic(params: Readonly<Record<K, string>>): string;
}

export type ChannelState = 'joining' | 'live' | 'catching-up' | 'offline' | 'failed';

export interface ChannelHandlers {
  /** An app's own ephemeral `events` frame on this channel. Never written to the store. */
  readonly onEvent?: (event: JsonObject) => void;
  /** A presence roster or delta — the `events` frames `readPresence` recognises. */
  readonly onPresence?: (event: PresenceEvent) => void;
}

/** Everything the book reaches on the client. Narrow, like `ClientFrameTarget`. */
export interface ChannelBookDeps {
  readonly store: RecordStore;
  send(frame: SubscribeFrame): void;
  connected(): boolean;
  /** Re-run the channel's catch-up read; its records land in the store through the transport. */
  catchUp(query: string, params: Readonly<Record<string, string>>): Promise<unknown>;
  report(error: unknown): void;
}

interface Entry {
  readonly topic: string;
  readonly name: string;
  readonly catchUp: string;
  readonly params: Readonly<Record<string, string>>;
  readonly holders: Set<ChannelHandlers>;
  readonly listeners: Set<() => void>;
  state: ChannelState;
  error: unknown;
  /** The epoch the cursor counts in; `null` before the first frame. */
  epoch: string | null;
  /** Highest seq with no hole below it — what a resubscribe resumes from. */
  contiguous: number | null;
  /** Applied seqs above `contiguous`: a replay that fills a hole is new, one above is a duplicate. */
  readonly above: Set<number>;
  /** Frames that arrived while the catch-up read was in flight, applied after it lands. */
  buffered: ChannelRecordsFrame[] | null;
}

export interface ChannelMembership extends Disposable {
  readonly topic: string;
  state(): ChannelState;
  error(): unknown;
  onChange(listener: () => void): () => void;
  release(): void;
}

export class ChannelBook {
  readonly #deps: ChannelBookDeps;
  readonly #byTopic = new Map<string, Entry>();

  constructor(deps: ChannelBookDeps) {
    this.#deps = deps;
  }

  /** Join (or share) one channel. N holders on one topic are ONE subscribe frame. */
  hold<K extends string>(
    ref: ChannelRef<K>,
    params: Readonly<Record<K, string>>,
    handlers: ChannelHandlers = {},
  ): ChannelMembership {
    const topic = ref.topic(params);
    let entry = this.#byTopic.get(topic);
    if (entry === undefined) {
      entry = {
        topic,
        name: ref.name,
        catchUp: ref.catchUp,
        params,
        holders: new Set(),
        listeners: new Set(),
        state: this.#deps.connected() ? 'joining' : 'offline',
        error: undefined,
        epoch: null,
        contiguous: null,
        above: new Set(),
        buffered: null,
      };
      this.#byTopic.set(topic, entry);
      if (this.#deps.connected()) this.#deps.send(this.#frame(entry, 'add', true));
    }
    const held = entry;
    held.holders.add(handlers);
    let open = true;
    const release = (): void => {
      if (!open) return;
      open = false;
      held.holders.delete(handlers);
      if (held.holders.size > 0) return;
      this.#byTopic.delete(topic);
      this.#deps.send(this.#frame(held, 'drop', false));
    };
    return {
      topic,
      state: () => held.state,
      error: () => held.error,
      onChange: (listener) => {
        held.listeners.add(listener);
        return () => {
          held.listeners.delete(listener);
        };
      },
      release,
      [Symbol.dispose]: release,
    };
  }

  /** Every membership again, on a new socket — resuming from each cursor. */
  resubscribe(): void {
    for (const entry of this.#byTopic.values()) {
      this.#set(entry, 'joining');
      this.#deps.send(this.#frame(entry, 'add', true));
    }
  }

  /** The presence heartbeat: repeat each membership with NO `since`, so the node replays nothing. */
  beat(): void {
    for (const entry of this.#byTopic.values()) this.#deps.send(this.#frame(entry, 'add', false));
  }

  offline(): void {
    for (const entry of this.#byTopic.values()) {
      if (entry.state !== 'failed') this.#set(entry, 'offline');
    }
  }

  /** The sid a channel is subscribed under — what a refusal `ack` names. */
  refused(sid: string, error: unknown): boolean {
    const entry = [...this.#byTopic.values()].find((candidate) => sidOf(candidate) === sid);
    if (entry === undefined) return false;
    entry.error = error;
    this.#set(entry, 'failed');
    return true;
  }

  records(frame: ChannelRecordsFrame): void {
    const entry = this.#byTopic.get(frame.channel);
    if (entry === undefined) return;
    if (entry.buffered !== null) {
      entry.buffered.push(frame);
      return;
    }
    if (entry.epoch !== null && entry.epoch !== frame.epoch) {
      // A new epoch: the node restarted or the client landed on another one. Its seqs mean
      // nothing against ours, so the channel is re-read and this frame waits behind the read.
      this.#catchUp(entry, [frame]);
      return;
    }
    this.#apply(entry, frame);
  }

  gap(frame: ReplayGapFrame): void {
    const entry = this.#byTopic.get(frame.channel);
    if (entry === undefined) return;
    this.#catchUp(entry, [], frame.epoch);
  }

  event(frame: ChannelEventsFrame): void {
    const entry = this.#byTopic.get(frame.channel);
    const presence = readPresence(frame.event);
    for (const holder of entry?.holders ?? []) {
      if (presence !== null) holder.onPresence?.(presence);
      else holder.onEvent?.(frame.event);
    }
  }

  /** Where a resubscribe resumes: the highest contiguous seq, in the epoch it counts in. */
  since(topic: string): { readonly epoch: string; readonly seq: number } | undefined {
    const entry = this.#byTopic.get(topic);
    if (entry?.epoch === null || entry?.contiguous === null || entry === undefined)
      return undefined;
    return { epoch: entry.epoch, seq: entry.contiguous };
  }

  #apply(entry: Entry, frame: ChannelRecordsFrame): void {
    if (entry.epoch === null) {
      entry.epoch = frame.epoch;
      entry.contiguous = frame.seq - 1;
    }
    const contiguous = entry.contiguous ?? frame.seq - 1;
    // A duplicate is dropped; a replayed seq filling a hole is new. A numeric hole on its own is
    // never a gap — a row this socket may not see is skipped for it; only `replay-gap` is.
    if (frame.seq <= contiguous || entry.above.has(frame.seq)) return;
    const store = this.#deps.store;
    store.batch(() => {
      for (const [type, rows] of Object.entries(frame.adopt ?? {})) store.adopt(type, rows);
      for (const [type, keys] of Object.entries(frame.remove ?? {})) store.remove(type, keys);
    });
    entry.above.add(frame.seq);
    let next = contiguous;
    while (entry.above.delete(next + 1)) next += 1;
    entry.contiguous = next;
    if (entry.state !== 'live') this.#set(entry, 'live');
  }

  /**
   * Re-read the channel through its catch-up query, holding every frame that arrives meanwhile;
   * then apply those, in order, over the read. The cursor restarts in the new epoch.
   */
  #catchUp(entry: Entry, pending: ChannelRecordsFrame[], epoch?: string): void {
    if (entry.buffered !== null) {
      entry.buffered.push(...pending);
      return;
    }
    entry.buffered = [...pending];
    entry.epoch = epoch ?? pending[0]?.epoch ?? entry.epoch;
    entry.contiguous = null;
    entry.above.clear();
    this.#set(entry, 'catching-up');
    this.#deps.catchUp(entry.catchUp, entry.params).then(
      () => this.#drain(entry),
      (error: unknown) => {
        this.#deps.report(error);
        this.#drain(entry);
      },
    );
  }

  #drain(entry: Entry): void {
    const held = entry.buffered ?? [];
    entry.buffered = null;
    // Frames of an epoch other than the one caught up to predate it; the read already holds them.
    const current = held.filter((frame) => frame.epoch === entry.epoch);
    current.sort((a, b) => a.seq - b.seq);
    for (const frame of current) {
      if (entry.contiguous === null) entry.contiguous = frame.seq - 1;
      this.#apply(entry, frame);
    }
    if (entry.state === 'catching-up') this.#set(entry, 'live');
  }

  #set(entry: Entry, state: ChannelState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }

  #frame(entry: Entry, op: 'add' | 'drop', resume: boolean): SubscribeFrame {
    const since = resume && op === 'add' ? this.since(entry.topic) : undefined;
    return {
      type: 'subscribe',
      v: PROTOCOL_VERSION,
      op,
      sid: sidOf(entry),
      target: {
        kind: 'channel',
        channel: entry.name,
        params: entry.params,
        ...(since === undefined ? {} : { since }),
      },
    };
  }
}

/** A channel membership's sid is its topic behind this — what the socket engine routes on too. */
export const CHANNEL_SID_PREFIX = 'channel:';

/** One sid per topic: re-sending it after a reconnect is the same membership, not a second one. */
function sidOf(entry: Entry): string {
  return `${CHANNEL_SID_PREFIX}${entry.topic}`;
}
