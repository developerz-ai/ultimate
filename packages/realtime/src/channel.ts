// Tier 1: channels. A declared `channel()` is subscribed by name + params — there is no other way
// to spell a topic. Its `records` are derived from the change feed on the node that delivers them
// (seq, epoch, ring, `replay-gap` — plan 101, slices 09-10), and its ephemeral `events` (presence
// included) fan out across nodes over the `Transport` bridge.

import {
  type Actor,
  assertCoded,
  type Ctx,
  ctxOf,
  finiteOption,
  logger,
  renderThrowable,
} from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { authorizeChannel } from './channel-authz';
import { type Bridge, unsubscribeWhenOpen } from './channel-bridge';
import type { Channel, Topic } from './channel-decl';
import { DenialLatch } from './channel-latch';
import { ChannelLogs, type ChannelTopic } from './channel-logs';
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

/** The longest value one channel param may carry — a uuid is 36. */
export const MAX_CHANNEL_PARAM_LENGTH = 128;

/** `#settle`'s "nobody has decided this seat yet": distinct from `null`, which is an actor. */
const UNDECIDED = Symbol('undecided');

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
  /** Topics a socket's policy refused, until its actor changes (`channel-latch.ts`). */
  readonly #latched: DenialLatch;
  /**
   * Topics whose guard could not DECIDE on a re-auth. Not a denial, so the seat and its bridge
   * reference are kept; not a pass either, so nothing is delivered until one succeeds.
   */
  readonly #suspended = new WeakMap<SyncSocket, Set<Topic>>();

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
    this.#latched = new DenialLatch(this.#maxTopicsPerSocket, 'maxTopicsPerSocket');
    this.#ctx = options.ctx ?? ctxOf();
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
      const value = Object.hasOwn(target.params, param) ? (target.params[param] ?? '') : '';
      // A topic is retained (the bridge table, the latch, the client's sid), and `topic()` checks
      // a segment's alphabet, never its size — so a param is the client's to grow only this far.
      if (value.length > MAX_CHANNEL_PARAM_LENGTH) {
        throw new TopicForbiddenError({
          topic: target.channel,
          actorId: socket.actorId,
          reason: `param "${param}" is ${value.length} characters; the limit is ${MAX_CHANNEL_PARAM_LENGTH}`,
        });
      }
      params[param] = value;
    }
    const name = declared.topic(params);
    if (this.#latched.has(socket, name)) {
      throw new TopicForbiddenError({
        topic: name,
        actorId: socket.actorId,
        reason: 'denied earlier on this connection; it is re-decided when the session changes',
      });
    }
    this.#latched.assertRoom(socket);
    const seat: ChannelTopic = { channel: declared, params };
    // A suspended seat asked for again (the client's beat) is the next pass, never a second seat.
    if (this.#suspended.get(socket)?.has(name) === true) {
      await this.#settle(socket, name, seat, UNDECIDED);
      return name;
    }
    // Asked before the join seats it: a repeated `add` (the presence beat) is not a fresh seat.
    const fresh = !socket.topics.has(name);
    // Captured, because the guard awaits and a re-auth may land under it: the verdict below is
    // about THIS actor, and `onActorChange` cannot re-decide a seat that does not exist yet.
    const actor = socket.actor;
    await this.#join(socket, name, async () => {
      try {
        await authorizeChannel(declared, this.#ctx, actor, name, params);
      } catch (error) {
        if (error instanceof TopicForbiddenError && socket.actor === actor) {
          this.#latched.add(socket, name);
        }
        throw error;
      }
    });
    // The socket died while the guard or the bridge was answering: `#join` gave the seat back, so
    // there is no member to open a ring for or to resume.
    if (!socket.topics.has(name)) return name;
    this.#logs.open(name, seat);
    await this.#settle(socket, name, seat, actor);
    // Dropped is a throw; suspended is a seat nothing is delivered on, the resume included.
    if (!socket.topics.has(name)) return name;
    this.#logs.resume(socket, name, target.since, fresh);
    return name;
  }

  /**
   * Decide a seat under the socket's CURRENT actor until the actor it was decided for is still the
   * one on the socket. A seat granted to the actor a re-auth has since replaced was kept until the
   * next grant expiry; a re-ask on a suspended seat ignored a denial and answered success.
   */
  async #settle(
    socket: SyncSocket,
    name: Topic,
    seat: ChannelTopic,
    decidedFor: Actor | null | typeof UNDECIDED,
  ): Promise<void> {
    let actor = decidedFor;
    while (actor === UNDECIDED || socket.actor !== actor) {
      actor = socket.actor;
      if ((await this.#decide(socket, name, seat, actor)) !== 'denied') continue;
      if (socket.actor === actor) this.#latched.add(socket, name);
      throw new TopicForbiddenError({
        topic: name,
        actorId: socket.actorId,
        reason: `channel "${seat.channel.name}" policy denied the subscribe`,
      });
    }
  }

  /**
   * Every open records topic is presumed to have missed a change: a new epoch, and every member
   * told `replay-gap`. The `sync` node calls it beside `LiveQueryRegistry.invalidate()` — seq is
   * minted here from the changes this node SEES, so a change the bus dropped leaves a hole the
   * ring cannot detect and would replay as complete history. Given an `entity`, only the topics
   * carrying it: what a bulk write the in-process replicator could not shape as rows stales.
   */
  invalidate(entity?: string): number {
    return this.#logs.invalidate(entity);
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
    assertCoded(
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
    // A topic this node holds open on a channel declared without `events` carries none: a
    // presence leave for it was an event on a channel whose members were promised records only.
    if (this.#logs.target(name)?.channel.events === false) return;
    const frame: ChannelEventsFrame = { type: 'events', v: PROTOCOL_VERSION, channel: name, event };
    await this.#transport.publish(`${CHANNEL_SUBJECT_PREFIX}.${name}`, JSON.stringify(frame));
  }

  /** The declaration and params a topic joined on this node resolves to — `undefined` if none. */
  channelOf(
    name: Topic,
  ): { readonly channel: Channel; readonly params: Readonly<Record<string, string>> } | undefined {
    return this.#logs.target(name);
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
    const held = socket.topics.size + (this.#suspended.get(socket)?.size ?? 0);
    if (held + claimed >= this.#maxTopicsPerSocket) {
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
    // The socket closed while this subscribe was parked: its teardown has already walked its
    // topics, so a seat taken now is a bridge pinned with no member and nothing left to release it.
    if (socket.closed) this.unsubscribe(socket, name);
  }

  unsubscribe(socket: SyncSocket, name: Topic): void {
    const suspended = this.#suspended.get(socket)?.delete(name) === true;
    if (!suspended && !socket.topics.has(name)) return;
    if (!suspended) this.#sockets.leaveTopic(socket, name);
    this.#release(name);
  }

  /** Every topic this socket holds a seat on — the delivered ones and the suspended ones. */
  topicsOf(socket: SyncSocket): readonly Topic[] {
    return [...socket.topics, ...(this.#suspended.get(socket) ?? [])] as Topic[];
  }

  /**
   * Called when a socket's session changes (login, logout, role change, token refresh).
   *
   * A denial drops the topic. Anything else is not a decision — a guard is app code and may reach
   * a database, and reading a store that timed out as a revoked grant dropped every topic on every
   * re-authenticated socket during one outage. It is not a pass either: the seat is kept and
   * SUSPENDED, so nothing is delivered on it until a later pass (the next re-auth, or the client's
   * own beat) decides. Returns the topics dropped — denials and nothing else.
   */
  async onActorChange(socket: SyncSocket, actor: Actor | null): Promise<readonly Topic[]> {
    socket.actor = actor;
    // A new session re-decides everything, the latched denials included.
    this.#latched.clear(socket);
    const dropped: Topic[] = [];
    for (const name of this.topicsOf(socket)) {
      const target = this.#logs.target(name);
      if (target === undefined) continue;
      if ((await this.#decide(socket, name, target, actor)) === 'denied') dropped.push(name);
    }
    return dropped;
  }

  /** One seat, re-decided: dropped on a denial, suspended on a failure, delivered on a pass. */
  async #decide(
    socket: SyncSocket,
    name: Topic,
    target: ChannelTopic,
    actor: Actor | null,
  ): Promise<'allowed' | 'denied' | 'undecided'> {
    try {
      await authorizeChannel(target.channel, this.#ctx, actor, name, target.params);
    } catch (error) {
      if (isPolicyDenial(error) || error instanceof TopicForbiddenError) {
        this.unsubscribe(socket, name);
        return 'denied';
      }
      this.#guardFailures += 1;
      logger.warn('channel.guard_failed', {
        topic: name,
        socketId: socket.id,
        error: renderThrowable(error),
      });
      if (socket.topics.has(name)) {
        this.#sockets.leaveTopic(socket, name);
        const suspended = this.#suspended.get(socket) ?? new Set<Topic>();
        this.#suspended.set(socket, suspended.add(name));
      }
      return 'undecided';
    }
    // Still suspended, and still open: a socket that closed meanwhile gave the seat back already.
    if (this.#suspended.get(socket)?.delete(name) === true) {
      this.#sockets.joinTopic(socket, name);
      // What the suspension withheld is unknown to the client, so a records channel is re-read.
      this.#logs.resume(socket, name, undefined, true);
    }
    return 'allowed';
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
