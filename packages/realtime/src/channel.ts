// Tier 1: channels. Typed topics over Bun's native WS pub/sub, fanned across nodes by `Transport`.
//
// A channel message rides the `patch` frame with `sid = topic` and `op: 'insert'` — a channel is an
// append-only stream, so tier 1 needs no frame of its own. That is why climbing the ladder is a
// config change: the client's frame handler is the same code at every rung.

import { type Actor, logger, renderThrowable } from '@ultimat3/core';
import { formatLsn } from './changefeed';
import {
  isPolicyDenial,
  SubscriptionLimitError,
  TopicForbiddenError,
  TransportUnavailableError,
} from './errors';
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
 * One topic's fanout into this node. `sub` is the transport subscription as a PROMISE, published
 * into the table before it is awaited: looked up before the await and written after it, two sockets
 * reaching one topic at once opened two transport subscriptions — the second replacing the first in
 * the table, and the first then unreachable by `#release`, by a socket dying, by `close()` or by
 * anything else, delivering every message on that topic a second time for the life of the process.
 *
 * `null` means the slot is taken and nothing is open yet: the node cap is decided before the guard
 * runs, so the reservation has to exist before there is anything to reserve it with.
 */
interface Bridge {
  sub: Promise<TransportSubscription> | null;
  refs: number;
}

/**
 * Deny by default: a topic with no matching guard is forbidden. An authz hole must be a typed
 * error at subscribe time, not a config option someone forgot to set.
 */
export class ChannelHub {
  readonly #transport: Transport;
  readonly #sockets: SocketRegistry;
  readonly #guards: Array<{ pattern: string; guard: TopicGuard }> = [];
  readonly #bridges = new Map<string, Bridge>();
  /**
   * Topics this socket has asked for and not yet joined. Weakly keyed, so it needs no teardown
   * path of its own: a socket that dies mid-subscribe takes its claims with it.
   */
  readonly #claimed = new WeakMap<SyncSocket, number>();
  readonly #maxTopicsPerSocket: number;
  readonly #maxTopicsPerNode: number;
  #guardFailures = 0;
  #sequence = 0n;
  /** Set by `close()`. Read by `#open`, which is the only thing that can reach a late subscription. */
  #closed = false;

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

  /**
   * `channel.guard_failed` for this node: guards that raised instead of deciding, during a re-auth.
   * Never a denial — the same split `LiveQueryRegistry.reauthorize` makes one layer up, and an
   * alert fires on one of them.
   */
  get guardFailures(): number {
    return this.#guardFailures;
  }

  /** `pattern` uses NATS wildcards: `org.*.cursors`, `org.>`. First registered match wins. */
  guard(pattern: string, guard: TopicGuard): this {
    this.#guards.push({ pattern, guard });
    return this;
  }

  /**
   * Both caps and the node's bridge slot are taken SYNCHRONOUSLY, before the guard is awaited: read
   * at the top and acted on after two awaits, one WebSocket write carrying N subscribe frames
   * passed each of them N times, and `maxTopicsPerSocket`/`maxTopicsPerNode` bounded nothing.
   */
  async subscribe(socket: SyncSocket, name: Topic): Promise<void> {
    if (socket.topics.has(name)) return;
    const claimed = this.#claimed.get(socket) ?? 0;
    if (socket.topics.size + claimed >= this.#maxTopicsPerSocket) {
      throw new SubscriptionLimitError({
        scope: 'socket',
        id: socket.id,
        limit: this.#maxTopicsPerSocket,
        // Named, never defaulted: the default for this scope is `maxPerSocket`, which is
        // `LiveQueryRegistry`'s cap on live subscriptions — a different ceiling in a different
        // constructor, so an operator following this fix line would have moved the wrong number.
        knob: 'maxTopicsPerSocket',
      });
    }
    // Refused before the guard runs and before a transport subscription is opened: a node that is
    // out of topics has nothing to decide, and the answer must not depend on who asked.
    const bridge = this.#reserve(name);
    this.#claimed.set(socket, claimed + 1);
    try {
      await this.#authorize(socket.actor, name);
      await this.#open(name, bridge);
    } catch (error) {
      // The slot this subscribe took, given back on the one path that will never fill it — and
      // given back to the bridge this subscribe actually reserved. `close()` clears the table, so
      // a later subscribe may have put a DIFFERENT bridge under this name in the meantime, and
      // decrementing that one's refs releases a topic somebody else is holding.
      this.#release(name, bridge);
      throw error;
    } finally {
      const held = this.#claimed.get(socket) ?? 1;
      if (held <= 1) this.#claimed.delete(socket);
      else this.#claimed.set(socket, held - 1);
    }
    // A concurrent subscribe for this same socket and topic got there first: it holds the one
    // membership this socket's close will give back, so the reference taken above has to go now or
    // it is a bridge nothing will ever release.
    if (socket.topics.has(name)) {
      this.#release(name, bridge);
      return;
    }
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

  /**
   * Called when a socket's session changes (login, logout, role change, token refresh).
   *
   * A denial drops the topic; anything else keeps it. A guard is app code and may reach a database,
   * so `catch { unsubscribe }` reported a store that timed out as a revoked grant — during one
   * outage, every topic on every re-authenticated socket on the node, silently, with the client
   * never told to resubscribe. The same split `LiveQueryRegistry.reauthorize` already makes, and
   * for the same reason: a failure is not a decision.
   */
  async onActorChange(socket: SyncSocket, actor: Actor | null): Promise<readonly Topic[]> {
    socket.actor = actor;
    const dropped: Topic[] = [];
    for (const name of [...socket.topics] as Topic[]) {
      try {
        await this.#authorize(actor, name);
      } catch (error) {
        if (isPolicyDenial(error) || error instanceof TopicForbiddenError) {
          this.unsubscribe(socket, name);
          dropped.push(name);
          continue;
        }
        this.#guardFailures += 1;
        logger.warn('channel.guard_failed', {
          topic: name,
          socketId: socket.id,
          error: renderThrowable(error),
        });
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
    // Set BEFORE the table is walked, because the table is not the whole story: a reservation an
    // in-flight `subscribe` has not opened yet is `sub === null`, so `unsubscribeWhenOpen` does
    // nothing to it and `clear()` drops the entry. That open then lands on a `Bridge` nothing can
    // name — `#release` looks the topic up, misses and returns — and its handler keeps calling
    // `deliver` for the life of the process. The same orphan the `Bridge` comment describes, one
    // state earlier, so the open that creates the subscription has to be the thing that closes it.
    this.#closed = true;
    for (const bridge of this.#bridges.values()) unsubscribeWhenOpen(bridge);
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

  /**
   * The node's slot for this topic, taken synchronously. One bridge per topic per node, refcounted
   * across sockets — and the refcount includes the subscribes still deciding, so the count the node
   * cap reads is the count that will exist.
   */
  #reserve(name: Topic): Bridge {
    const existing = this.#bridges.get(name);
    if (existing) {
      existing.refs += 1;
      return existing;
    }
    if (this.#bridges.size >= this.#maxTopicsPerNode) {
      throw new SubscriptionLimitError({
        scope: 'node',
        id: 'topics',
        limit: this.#maxTopicsPerNode,
        knob: 'maxTopicsPerNode',
      });
    }
    const created: Bridge = { sub: null, refs: 1 };
    this.#bridges.set(name, created);
    return created;
  }

  /** Opens the reserved bridge once, and shares the in-flight open with everyone else waiting. */
  async #open(name: Topic, bridge: Bridge): Promise<void> {
    // Published into the bridge before it is awaited: that is what makes a second subscriber join
    // this open instead of starting a second one the table can never reach again.
    bridge.sub ??= this.#transport.subscribe(`${CHANNEL_SUBJECT_PREFIX}.${name}`, (payload) => {
      this.#sockets.deliver(name, decode(payload));
    });
    await bridge.sub;
    // The hub shut down while the transport was answering. `close()` either never saw this bridge
    // or saw it with nothing to close, so this is the last reference to the subscription: it closes
    // here or never. The entry goes with it, so a second post-close subscribe opens and closes its
    // own rather than double-unsubscribing this one's handle.
    if (this.#closed) {
      unsubscribeWhenOpen(bridge);
      if (this.#bridges.get(name) === bridge) this.#bridges.delete(name);
      // RAISED, not returned. Returning let `subscribe` fall through to `joinTopic`, so the socket
      // became a member of a topic nothing on this node is bridged to: silent for the life of the
      // connection, with no error on either side and nothing telling the client to redial. The
      // same refusal the transport itself answers when it is gone, because from the client's side
      // that is what happened — this node's bus for that topic is closed.
      throw new TransportUnavailableError({
        transport: 'channel',
        reason: `the hub closed while "${name}" was opening`,
        fix: 'reconnect and resubscribe — this node is draining',
      });
    }
  }

  /**
   * `expected` is the bridge the caller reserved. Without it a release looks the topic up by name,
   * and after a `close()` cleared the table that name may hold a bridge a LATER subscribe opened.
   */
  #release(name: Topic, expected?: Bridge): void {
    const bridge = this.#bridges.get(name);
    if (!bridge) return;
    if (expected !== undefined && bridge !== expected) return;
    bridge.refs -= 1;
    if (bridge.refs > 0) return;
    unsubscribeWhenOpen(bridge);
    this.#bridges.delete(name);
  }
}

/**
 * A bridge released while its subscription is still opening still has to be closed — the transport
 * hands the handle back after the caller has gone, and dropping the promise would leave a live
 * subscription this node can no longer name. An open that failed has nothing to unsubscribe and its
 * rejection was already answered to the subscriber that caused it.
 */
function unsubscribeWhenOpen(bridge: Bridge): void {
  void bridge.sub?.then(
    (sub) => {
      sub.unsubscribe();
    },
    () => undefined,
  );
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
