// Tier 1: channels. A declared `channel()` is subscribed by name + params — there is no other way
// to spell a topic. Its `records` are derived from the change feed on the node that delivers them
// (seq, epoch, ring, `replay-gap` — plan 101, slices 09-10), and its ephemeral `events` (presence
// included) fan out across nodes over the `Transport` bridge.

import {
  type Actor,
  type Ctx,
  createContext,
  finiteOption,
  invariant,
  logger,
  renderThrowable,
} from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { authorizeChannel } from './channel-authz';
import { type Bridge, unsubscribeWhenOpen } from './channel-bridge';
import type { Channel, Topic } from './channel-decl';
import { ChannelLogs } from './channel-logs';
import { getChannel, registeredChannels } from './channel-registry';
import type { ChannelEventsFrame, ChannelSubscribeTarget } from './channel-wire';
import {
  isPolicyDenial,
  SubscriptionLimitError,
  TopicForbiddenError,
  TransportUnavailableError,
} from './errors';
import type { Transport } from './fanout';
import type { JsonObject } from './json';
import type { SocketRegistry, SyncSocket } from './socket';
import { decode, PROTOCOL_VERSION } from './sync-protocol';

export { type Topic, topic } from './channel-decl';

const CHANNEL_SUBJECT_PREFIX = 'x.channel';

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
  /** Scope the hub to these declarations. Omitted = every `channel()` registered in the process. */
  readonly channels?: readonly Channel[];
  /** The node context a channel policy is evaluated under, as a live query's is. */
  readonly ctx?: Ctx;
  /** `records` frames kept per topic for a `since` resume. See `DEFAULT_CHANNEL_RING`. */
  readonly ringSize?: number;
}

/** Distinct topics one node bridges before `X_SUBSCRIPTION_LIMIT`. */
export const DEFAULT_MAX_TOPICS_PER_NODE = 10_000;

/**
 * Deny by default: a channel name no `channel()` declared is refused, so an authz hole is a typed
 * error at subscribe time, never a topic somebody forgot to guard.
 */
export class ChannelHub {
  readonly #transport: Transport;
  readonly #sockets: SocketRegistry;
  readonly #bridges = new Map<string, Bridge>();
  /**
   * Topics this socket has asked for and not yet joined. Weakly keyed, so it needs no teardown
   * path of its own: a socket that dies mid-subscribe takes its claims with it.
   */
  readonly #claimed = new WeakMap<SyncSocket, number>();
  readonly #maxTopicsPerSocket: number;
  readonly #maxTopicsPerNode: number;
  #guardFailures = 0;
  /** Set by `close()`. Read by `#open`, which is the only thing that can reach a late subscription. */
  #closed = false;
  /**
   * `null` serves every registered channel — the default, so a host passes nothing. A list scopes
   * this hub to exactly those declarations (a test, a node that serves a subset).
   */
  readonly #only: ReadonlyMap<string, Channel> | null;
  readonly #logs: ChannelLogs;
  readonly #ctx: Ctx;
  /**
   * Topics a socket's policy refused, latched until its actor changes: a denial is a decision, so
   * a client re-asking in a loop is answered without re-running the policy each time — and only
   * THAT channel is refused, every other one on the socket keeps flowing.
   */
  readonly #latched = new WeakMap<SyncSocket, Set<string>>();

  constructor(options: ChannelHubOptions) {
    this.#transport = options.transport;
    this.#sockets = options.sockets;
    this.#maxTopicsPerSocket = finiteOption(
      'ChannelHub',
      'maxTopicsPerSocket',
      options.maxTopicsPerSocket ?? 64,
    );
    this.#maxTopicsPerNode = finiteOption(
      'ChannelHub',
      'maxTopicsPerNode',
      options.maxTopicsPerNode ?? DEFAULT_MAX_TOPICS_PER_NODE,
    );
    this.#ctx = options.ctx ?? createContext();
    this.#logs = new ChannelLogs(options.sockets, options.ringSize);
    this.#only =
      options.channels === undefined ? null : new Map(options.channels.map((c) => [c.name, c]));
  }

  /**
   * Join a declared channel by name + params. The policy runs with the params as input; a denial
   * is latched per (socket, topic). With `since`, the ring replays what was missed or a
   * `replay-gap` says to re-read. Answers the topic, which presence keys its set by.
   */
  async subscribeChannel(socket: SyncSocket, target: ChannelSubscribeTarget): Promise<Topic> {
    const declared =
      this.#only === null ? getChannel(target.channel) : this.#only.get(target.channel);
    if (declared === undefined) {
      throw new TopicForbiddenError({
        topic: target.channel,
        actorId: socket.actorId,
        reason: 'no channel() is declared with this name on this node',
      });
    }
    const params: Record<string, string> = {};
    for (const param of declared.params) {
      params[param] = Object.hasOwn(target.params, param) ? (target.params[param] ?? '') : '';
    }
    const name = declared.topic(params);
    if (this.#latched.get(socket)?.has(name) === true) {
      throw new TopicForbiddenError({
        topic: name,
        actorId: socket.actorId,
        reason: 'denied earlier on this connection; it is re-decided when the session changes',
      });
    }
    // Asked before the join seats it: a repeated `add` (the presence beat) is not a fresh seat.
    const fresh = !socket.topics.has(name);
    await this.#join(socket, name, async () => {
      try {
        await authorizeChannel(declared, this.#ctx, socket.actor, name, params);
      } catch (error) {
        if (error instanceof TopicForbiddenError) this.#latch(socket, name);
        throw error;
      }
    });
    this.#logs.open(name, { channel: declared, params });
    this.#logs.resume(socket, name, target.since, fresh);
    return name;
  }

  /**
   * One committed change from the feed, turned into `records` frames on every declared channel it
   * touches and delivered on THIS node. Called for every change the node receives — the same
   * stream `LiveQueryRegistry.deliver` is fed — so a write names no channel (axiom 2).
   */
  deliverChange(change: ChangeEvent): number {
    return this.#logs.deliverChange(this.#only?.values() ?? registeredChannels(), change);
  }

  /** An ephemeral event (typing, a cursor) to every node's members of that topic. Never stored. */
  async publishEvent<K extends string>(
    declared: Channel<K>,
    params: Readonly<Record<K, string>>,
    event: JsonObject,
  ): Promise<void> {
    invariant(
      declared.events,
      'X_CHANNEL_DECLARATION_INVALID',
      `channel("${declared.name}") declares no events, so nothing may publish one on it`,
      `declare it with events: true: channel('${declared.name}', { …, events: true })`,
    );
    await this.emit(declared.topic(params), event);
  }

  /**
   * An `events` frame on a topic this node already resolved — `publishEvent`'s second half, and
   * presence's one way out: a roster change is an event on the channel the member joined. Never
   * a topic a caller spelled; every `Topic` comes from a declaration.
   */
  async emit(name: Topic, event: JsonObject): Promise<void> {
    const frame: ChannelEventsFrame = { type: 'events', v: PROTOCOL_VERSION, channel: name, event };
    await this.#transport.publish(`${CHANNEL_SUBJECT_PREFIX}.${name}`, JSON.stringify(frame));
  }

  /** The declaration and params a topic joined on this node resolves to — `undefined` if none. */
  channelOf(
    name: Topic,
  ): { readonly channel: Channel; readonly params: Readonly<Record<string, string>> } | undefined {
    return this.#logs.target(name);
  }

  #latch(socket: SyncSocket, name: string): void {
    const latched = this.#latched.get(socket) ?? new Set<string>();
    latched.add(name);
    this.#latched.set(socket, latched);
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

  /**
   * Both caps and the node's bridge slot are taken SYNCHRONOUSLY, before the guard is awaited: read
   * at the top and acted on after two awaits, one WebSocket write carrying N subscribe frames
   * passed each of them N times, and `maxTopicsPerSocket`/`maxTopicsPerNode` bounded nothing.
   */
  async #join(socket: SyncSocket, name: Topic, authorize: () => Promise<void>): Promise<void> {
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
      await authorize();
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
    // A new session re-decides everything, the latched denials included.
    this.#latched.delete(socket);
    const dropped: Topic[] = [];
    for (const name of [...socket.topics] as Topic[]) {
      try {
        const target = this.#logs.target(name);
        if (target !== undefined) {
          await authorizeChannel(target.channel, this.#ctx, actor, name, target.params);
        }
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
        // The reader is a browser websocket client, which cannot run a CLI — so pure command
        // advice would be worse than prose here. The shape that satisfies axiom 4 anyway is
        // `http/src/error-map.ts`'s: a command that SHIPS (`x errors explain`, unlike the planned
        // `x logs tail`) for whoever is holding a terminal, then the instruction as a comment.
        fix: 'x errors explain X_TRANSPORT_UNAVAILABLE --json   # then reconnect and resubscribe: this node is draining',
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
    // The ring goes with the last local member; a later subscriber starts a new epoch.
    this.#logs.close(name);
  }
}
