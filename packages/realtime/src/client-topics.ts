// The client's channel book: which handlers hold which topic, and the one frame that announces a
// membership. Split out of `client.ts` because the announcement has two callers that must never
// disagree — `subscribe()` and the reconnect replay — and one of them was missing.

import type { Topic } from './channel';
import type { JsonObject } from './json';
import { PROTOCOL_VERSION, type SubscribeFrame } from './sync-protocol';

export type TopicHandler = (message: JsonObject) => void;

/**
 * The membership frame. `sid` is the topic itself: a channel subscription is identified by what it
 * is subscribed to, so re-sending it after a reconnect re-establishes the same membership rather
 * than a second one — and on the node, sending it again IS the presence heartbeat.
 */
export function topicSubscribeFrame(name: string, op: 'add' | 'drop'): SubscribeFrame {
  return {
    type: 'subscribe',
    v: PROTOCOL_VERSION,
    op,
    sid: name,
    target: { kind: 'topic', topic: name },
  };
}

/** Topic -> the handlers holding it. One entry per topic, however many components subscribed. */
export class TopicBook {
  readonly #topics = new Map<string, Set<TopicHandler>>();

  add(name: Topic, handler: TopicHandler): void {
    const handlers = this.#topics.get(name) ?? new Set<TopicHandler>();
    handlers.add(handler);
    this.#topics.set(name, handlers);
  }

  /** True when that was the last holder, so the caller is the one that sends the drop frame. */
  remove(name: Topic, handler: TopicHandler): boolean {
    const handlers = this.#topics.get(name);
    if (!handlers) return false;
    handlers.delete(handler);
    if (handlers.size > 0) return false;
    this.#topics.delete(name);
    return true;
  }

  handlers(name: string): ReadonlySet<TopicHandler> | undefined {
    return this.#topics.get(name);
  }

  /** Every membership this client still holds — what a reconnect has to re-announce. */
  names(): readonly string[] {
    return [...this.#topics.keys()];
  }
}
