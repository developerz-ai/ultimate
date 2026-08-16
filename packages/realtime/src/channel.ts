// Tier 1: channels. Typed topics over Bun's native WS pub/sub, fanned across nodes by `Transport`.
//
// A channel message rides the `patch` frame with `sid = topic` and `op: 'insert'` — a channel is an
// append-only stream, so tier 1 needs no frame of its own. That is why climbing the ladder is a
// config change: the client's frame handler is the same code at every rung.

import type { Actor } from '@ultimat3/core';
import { formatLsn } from './changefeed';
import { SubscriptionLimitError, TopicForbiddenError } from './errors';
import { subjectMatches, type Transport, type TransportSubscription } from './fanout';
import type { JsonObject } from './json';
import type { SocketRegistry, SyncSocket } from './socket';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

/** Branded so a raw string can never be published to; `topic()` is the only constructor. */
export type Topic = string & { readonly __ultimateTopic: unique symbol };

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const CHANNEL_SUBJECT_PREFIX = 'x.channel';

/** `topic('org', orgId, 'cursors')` -> `org.<orgId>.cursors`. Segments are validated, never escaped. */
export function topic(...parts: readonly (string | number)[]): Topic {
  const segments = parts.map((part) => String(part));
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new TopicForbiddenError({
        topic: segments.join('.'),
        actorId: null,
        reason: `segment "${segment}" must match ${SEGMENT.source} (dots and wildcards are reserved)`,
      });
    }
  }
  return segments.join('.') as Topic;
}

export interface TopicGuardArgs {
  readonly actor: Actor | null;
  readonly topic: Topic;
  readonly segments: readonly string[];
}

export type TopicGuardResult = boolean | { readonly allowed: boolean; readonly reason?: string };
export type TopicGuard = (args: TopicGuardArgs) => TopicGuardResult | Promise<TopicGuardResult>;

export interface ChannelHubOptions {
  readonly transport: Transport;
  readonly sockets: SocketRegistry;
  readonly maxTopicsPerSocket?: number;
  /**
   * Distinct topics this node will bridge at once. Each one is a live transport subscription, and
   * `topic()` admits any `[A-Za-z0-9_-]+` segment — so even a guard as tight as `org.<myorg>.>`
   * admits unbounded distinct names inside one tenant, and a per-socket cap bounds nothing.
   */
  readonly maxTopicsPerNode?: number;
}

/** Distinct topics one node bridges before `X_SUBSCRIPTION_LIMIT`. */
export const DEFAULT_MAX_TOPICS_PER_NODE = 10_000;

/**
 * Deny by default: a topic with no matching guard is forbidden. An authz hole must be a typed
 * error at subscribe time, not a config option someone forgot to set.
 */
export class ChannelHub {
  readonly #transport: Transport;
  readonly #sockets: SocketRegistry;
  readonly #guards: Array<{ pattern: string; guard: TopicGuard }> = [];
  readonly #bridges = new Map<string, { sub: TransportSubscription; refs: number }>();
  readonly #maxTopicsPerSocket: number;
  readonly #maxTopicsPerNode: number;
  #sequence = 0n;

  constructor(options: ChannelHubOptions) {
    this.#transport = options.transport;
    this.#sockets = options.sockets;
    this.#maxTopicsPerSocket = options.maxTopicsPerSocket ?? 64;
    this.#maxTopicsPerNode = options.maxTopicsPerNode ?? DEFAULT_MAX_TOPICS_PER_NODE;
  }

  /** Sockets this node will deliver `name` to. The metric the fanout reads. */
  subscriberCount(name: Topic): number {
    return this.#sockets.subscriberCount(name);
  }

  /** Distinct topics bridged from this node — one live transport subscription each. */
  get topicCount(): number {
    return this.#bridges.size;
  }

  /** `pattern` uses NATS wildcards: `org.*.cursors`, `org.>`. First registered match wins. */
  guard(pattern: string, guard: TopicGuard): this {
    this.#guards.push({ pattern, guard });
    return this;
  }

  async subscribe(socket: SyncSocket, name: Topic): Promise<void> {
    if (socket.topics.has(name)) return;
    if (socket.topics.size >= this.#maxTopicsPerSocket) {
      throw new SubscriptionLimitError({
        scope: 'socket',
        id: socket.id,
        limit: this.#maxTopicsPerSocket,
      });
    }
    // Refused before the guard runs and before a transport subscription is opened: a node that is
    // out of topics has nothing to decide, and the answer must not depend on who asked.
    if (!this.#bridges.has(name) && this.#bridges.size >= this.#maxTopicsPerNode) {
      throw new SubscriptionLimitError({
        scope: 'node',
        id: 'topics',
        limit: this.#maxTopicsPerNode,
        knob: 'maxTopicsPerNode',
      });
    }
    await this.#authorize(socket.actor, name);
    await this.#bridge(name);
    // Through the registry, never `socket.subscribeTopic` directly: membership and the index the
    // fanout reads are one fact, and two call sites for one fact is the drift that makes an index
    // wrong. The registry owns it because it is the only thing that sees a socket die.
    this.#sockets.joinTopic(socket, name);
  }

  unsubscribe(socket: SyncSocket, name: Topic): void {
    if (!socket.topics.has(name)) return;
    this.#sockets.leaveTopic(socket, name);
    this.#release(name);
  }

  /** Called when a socket's session changes (login, logout, role change, token refresh). */
  async onActorChange(socket: SyncSocket, actor: Actor | null): Promise<readonly Topic[]> {
    socket.actor = actor;
    const dropped: Topic[] = [];
    for (const name of [...socket.topics] as Topic[]) {
      try {
        await this.#authorize(actor, name);
      } catch {
        this.unsubscribe(socket, name);
        dropped.push(name);
      }
    }
    return dropped;
  }

  /** Publishes to every node. Local delivery happens via the transport bridge, never directly. */
  async publish(name: Topic, message: JsonObject): Promise<void> {
    this.#sequence += 1n;
    const frame = channelFrame(name, formatLsn(this.#sequence), message);
    await this.#transport.publish(`${CHANNEL_SUBJECT_PREFIX}.${name}`, encode(frame));
  }

  /** Frames already encoded elsewhere (presence, for one) reuse the same bridge. */
  async publishFrame(name: Topic, frame: Frame): Promise<void> {
    await this.#transport.publish(`${CHANNEL_SUBJECT_PREFIX}.${name}`, encode(frame));
  }

  async close(): Promise<void> {
    for (const bridge of this.#bridges.values()) bridge.sub.unsubscribe();
    this.#bridges.clear();
  }

  async #authorize(actor: Actor | null, name: Topic): Promise<void> {
    const segments = name.split('.');
    const entry = this.#guards.find(({ pattern }) => subjectMatches(pattern, name));
    if (!entry) {
      throw new TopicForbiddenError({
        topic: name,
        actorId: actor === null ? null : actor.id,
        reason: 'no guard declared for this topic',
      });
    }
    const result = await entry.guard({ actor, topic: name, segments });
    const allowed = typeof result === 'boolean' ? result : result.allowed;
    if (!allowed) {
      const reason =
        typeof result === 'boolean' ? 'guard denied' : (result.reason ?? 'guard denied');
      throw new TopicForbiddenError({
        topic: name,
        actorId: actor === null ? null : actor.id,
        reason,
      });
    }
  }

  /** One transport subscription per topic per node, refcounted across sockets. */
  async #bridge(name: Topic): Promise<void> {
    const existing = this.#bridges.get(name);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const sub = await this.#transport.subscribe(`${CHANNEL_SUBJECT_PREFIX}.${name}`, (payload) => {
      this.#sockets.deliver(name, decode(payload));
    });
    this.#bridges.set(name, { sub, refs: 1 });
  }

  #release(name: Topic): void {
    const bridge = this.#bridges.get(name);
    if (!bridge) return;
    bridge.refs -= 1;
    if (bridge.refs > 0) return;
    bridge.sub.unsubscribe();
    this.#bridges.delete(name);
  }
}

export function channelFrame(name: Topic, lsn: string, message: JsonObject): Frame {
  return {
    type: 'patch',
    v: PROTOCOL_VERSION,
    sid: name,
    lsn,
    patches: [{ op: 'insert', id: lsn, row: message, lsn }],
  };
}
