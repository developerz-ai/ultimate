// The sid each of a socket's channel seats was answered under, keyed by TOPIC. A sid is client
// data: keyed by it, one socket minted an entry per fresh sid without bound, and two sids naming
// one topic aliased one membership — dropping either unsubscribed the other.

import type { Topic } from './channel-decl';
import type { SyncSocket } from './socket';

/** Weakly keyed by socket, so a socket's entries die with it; bounded by the hub's topic cap. */
export class ChannelSids {
  readonly #bySocket = new WeakMap<SyncSocket, Map<Topic, string>>();

  /** The latest sid wins: a repeated `add` under a new sid re-names the one seat, never adds one. */
  set(socket: SyncSocket, topic: Topic, sid: string): void {
    const topics = this.#bySocket.get(socket) ?? new Map<Topic, string>();
    this.#bySocket.set(socket, topics.set(topic, sid));
  }

  /** The sid a refusal for this seat must name — `undefined` when the socket holds no such seat. */
  sidOf(socket: SyncSocket, topic: Topic): string | undefined {
    return this.#bySocket.get(socket)?.get(topic);
  }

  /** The topic currently held under `sid`. A sid an earlier `add` was re-named away from holds none. */
  topicOf(socket: SyncSocket, sid: string): Topic | undefined {
    for (const [topic, held] of this.#bySocket.get(socket) ?? []) if (held === sid) return topic;
    return undefined;
  }

  delete(socket: SyncSocket, topic: Topic): void {
    this.#bySocket.get(socket)?.delete(topic);
  }

  /** Seats recorded for one socket — what a test bounds. */
  count(socket: SyncSocket): number {
    return this.#bySocket.get(socket)?.size ?? 0;
  }
}
