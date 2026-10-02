// What a RECEIVED frame does to server state — the mirror of `client-frames.ts`, and the only
// inbound surface the `sync` node exposes. Every dependency is injected, so the router is
// exercisable without a socket, a bus or a server.

import { logger } from '@ultimat3/core';
import type { ChannelHub } from './channel';
import type { Topic } from './channel-decl';
import { ChannelSids } from './channel-sids';
import { FrameRateLimitError, ProtocolVersionError } from './errors';
import { FrameLanes, laneKeyOf } from './frame-lanes';
import type { LiveQueryRegistry } from './live-query';
import { type PresenceRegistry, presenceFrame } from './presence';
import type { SyncSocket } from './socket';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

export interface FrameRouterOptions {
  readonly hub: ChannelHub;
  readonly registry: LiveQueryRegistry;
  readonly buildId: string;
  readonly presence?: PresenceRegistry | undefined;
  /** What the `hello` reply tells a client to beat at — `clientHeartbeatMs` on a real node. */
  readonly heartbeatMs?: number | undefined;
  /** Shared with the node, which names a seat's sid when a re-auth drops it. */
  readonly channelSids?: ChannelSids | undefined;
}

/**
 * The longest `sid` a subscribe frame may carry. A sid is retained — in the subscription book, in
 * `ChannelSids`, and echoed in every ack — so its size is the client's to choose only up to here.
 * The bundled client sends a uuid for a live query and `channel:<topic>` for a channel, so the
 * ceiling sits well above a topic of several uuid params.
 */
export const MAX_SID_LENGTH = 512;

export type FrameRouter = (socket: SyncSocket, frame: Frame) => Promise<void>;

/**
 * What a refusal ack refers to. `ack.ref` is how a client finds the thing that failed — the sid
 * of the subscription it refused, so that one window renders `failed` and no other does. The
 * socket id is the answer for a frame nothing could read (a decode failure) and for the kinds that
 * carry no reference of their own, because there is nothing else true to say.
 */
export function ackRefOf(frame: Frame | null, socketId: string): string {
  if (frame === null) return socketId;
  // An oversized sid is the refusal's reason, never its echo.
  if (frame.type === 'subscribe' && frame.sid.length <= MAX_SID_LENGTH) return frame.sid;
  return socketId;
}

export function createFrameRouter(options: FrameRouterOptions): FrameRouter {
  const presence = options.presence;
  const channelSids = options.channelSids ?? new ChannelSids();

  /**
   * Subscribing to a channel declared `events: true` IS joining its presence set: presence has no
   * frame of its own (it rides that channel's `events`), so a second round trip saying "and I am
   * here" would be a second way to do one thing. A records-only channel has no roster.
   *
   * Repeating the frame is the heartbeat. A beat renews the member's TTL (`heartbeat`) instead of
   * joining again — that was a KV put and a fleet-wide `join` event per member per beat — and is
   * still answered with the whole roster: a presence delta is an ephemeral frame, so the roster a
   * beat brings back is what repairs a client that lost one. A member that had already expired is
   * joined again in full.
   *
   * A node built WITHOUT presence still answers: an events-only channel is sent nothing else, so
   * unanswered its subscriber read `joining` until the first app event. The answer is the roster
   * this node can vouch for — nobody.
   */
  const joinPresence = async (socket: SyncSocket, name: Topic, beat: boolean): Promise<void> => {
    if (options.hub.channelOf(name)?.channel.events !== true) return;
    const roster = !presence
      ? { members: [], total: 0 }
      : beat && (await presence.heartbeat(name, socket.id))
        ? await presence.roster(name)
        : await presence.join(name, { id: socket.id, actorId: socket.actorId });
    // Read, though nothing here can repair it: the next beat re-sends the set, and the log is the
    // only trace a dropped one leaves anywhere.
    if (!socket.send(presenceFrame(name, 'sync', roster.members, roster.total))) {
      logger.warn('sync.presence_roster_dropped', { topic: name, socketId: socket.id });
    }
  };
  // Weakly keyed, so one socket's lanes die with it and no close path has to remember them.
  const lanes = new WeakMap<SyncSocket, FrameLanes>();

  const routeFrame: FrameRouter = async (socket, frame) => {
    // Before `touch()` and before every amplifier below it: a frame this node refuses to route
    // must not also renew the idle window that would otherwise close a flooding socket.
    if (!socket.frameBudget.tryAccept()) {
      throw new FrameRateLimitError({
        socketId: socket.id,
        perSecond: socket.frameBudget.perSecond,
      });
    }
    socket.touch();
    const key = laneKeyOf(frame);
    if (key === null) return await apply(socket, frame);
    // Entered synchronously — an `async` body runs to its first await on the call — so the lane
    // order is the order `sync-node.message` was called in, which is the order the bytes arrived.
    const lane = lanes.get(socket) ?? new FrameLanes();
    lanes.set(socket, lane);
    return await lane.run(key, () => apply(socket, frame));
  };
  return routeFrame;

  async function apply(socket: SyncSocket, frame: Frame): Promise<void> {
    switch (frame.type) {
      case 'hello': {
        // Before `skewed` is asked: the frame is the client's word on its build, and the upgrade
        // may have recorded none (a dial without `?build=` defaults to this node's own id).
        socket.sawHello(frame.buildId);
        socket.send({
          type: 'hello',
          v: PROTOCOL_VERSION,
          buildId: options.buildId,
          sessionId: socket.id,
          // The actor the upgrade resolved, so a client can render who the server thinks it is
          // rather than who it thinks it sent.
          actorId: socket.actorId,
          // The beat this node's REAL presence ttl and idle budget need. A client cannot read
          // either, and one beating on its own default under a shorter ttl is a false leave.
          ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        });
        if (socket.skewed) {
          socket.send({ type: 'update-available', v: PROTOCOL_VERSION, buildId: options.buildId });
        }
        return;
      }
      case 'subscribe': {
        if (frame.sid.length > MAX_SID_LENGTH) {
          throw new ProtocolVersionError({
            got: PROTOCOL_VERSION,
            expected: PROTOCOL_VERSION,
            detail: `subscribe.sid is ${frame.sid.length} characters; the limit is ${MAX_SID_LENGTH}`,
          });
        }
        if (frame.target.kind === 'channel') {
          if (frame.op === 'drop') {
            // The topic is the DECLARATION's to spell (`channel.topic(params)`), so a drop finds
            // it by the sid its add was answered under — never by re-deriving it from client data.
            const name = channelSids.topicOf(socket, frame.sid);
            if (name === undefined) return;
            channelSids.delete(socket, name);
            const events = options.hub.channelOf(name)?.channel.events === true;
            options.hub.unsubscribe(socket, name);
            if (presence && events) await presence.leave(name, socket.id);
            return;
          }
          // A seat this sid already names may be DENIED by this ask (a suspended seat re-decided):
          // the hub drops it, and the sid and the presence member must not outlive it.
          const held = channelSids.topicOf(socket, frame.sid);
          const room = held !== undefined && options.hub.channelOf(held)?.channel.events === true;
          let name: Topic;
          try {
            name = await options.hub.subscribeChannel(socket, frame.target);
          } catch (error) {
            if (held !== undefined && !options.hub.topicsOf(socket).includes(held)) {
              channelSids.delete(socket, held);
              if (presence && room) await presence.leave(held, socket.id);
            }
            throw error;
          }
          // Not seated: the socket died while the guard was answering (a presence member written
          // now is one no close will ever remove), or the seat is SUSPENDED — its guard could not
          // decide — and a roster is exactly the delivery a suspension withholds.
          if (socket.closed || !socket.topics.has(name)) return;
          // A seat this socket already held makes the frame its beat, never a second join.
          const beat = channelSids.sidOf(socket, name) !== undefined;
          channelSids.set(socket, name, frame.sid);
          await joinPresence(socket, name, beat);
          return;
        }
        if (frame.op === 'drop') {
          // Scoped to this socket: a sid is client data, and an unscoped drop let one client
          // end another's live stream by guessing — or reusing — its id.
          options.registry.unsubscribe(socket.id, frame.sid);
          return;
        }
        const { frame: reply } = await options.registry.subscribe({
          socket,
          name: frame.target.qid,
          input: frame.target.input,
          sid: frame.sid,
          cursor: frame.target.cursor,
        });
        // `subscribe` has already seated the subscription and cleared its desync mark, so a reply
        // the socket refuses leaves the server believing a client that holds no rows is in sync:
        // the next change reaches it as a PATCH folded onto nothing, forever, on a socket that has
        // since drained. Marked instead, which is the state it is actually in — the next delivery
        // re-snapshots it out of the shared window, exactly as `live-fanout` does for a lost patch.
        if (!socket.send(reply)) socket.markDesynced(frame.sid);
        return;
      }
      // Server-authored frames are never received from a client.
      case 'snapshot':
      case 'patch':
      case 'ack':
      case 'records':
      case 'events':
      case 'replay-gap':
      case 'reconnect':
      case 'update-available':
        return;
    }
  }
}
