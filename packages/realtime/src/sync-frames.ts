// What a RECEIVED frame does to server state — the mirror of `client-frames.ts`, and the only
// inbound surface the `sync` node exposes. Every dependency is injected, so the router is
// exercisable without a socket, a bus or a server.

import { logger } from '@ultimat3/core';
import type { ChannelHub } from './channel';
import type { Topic } from './channel-decl';
import { FrameRateLimitError } from './errors';
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
}

export type FrameRouter = (socket: SyncSocket, frame: Frame) => Promise<void>;

/**
 * What a refusal ack refers to. `ack.ref` is how a client finds the thing that failed — the sid
 * of the subscription it refused, so that one window renders `failed` and no other does. The
 * socket id is the answer for a frame nothing could read (a decode failure) and for the kinds that
 * carry no reference of their own, because there is nothing else true to say.
 */
export function ackRefOf(frame: Frame | null, socketId: string): string {
  if (frame === null) return socketId;
  if (frame.type === 'subscribe') return frame.sid;
  return socketId;
}

export function createFrameRouter(options: FrameRouterOptions): FrameRouter {
  const presence = options.presence;
  /** Per socket: the topic each channel sid was joined under. Dies with the socket. */
  const channelTopics = new WeakMap<SyncSocket, Map<string, Topic>>();

  /**
   * Subscribing to a channel declared `events: true` IS joining its presence set: presence has no
   * frame of its own (it rides that channel's `events`), so a second round trip saying "and I am
   * here" would be a second way to do one thing. A records-only channel has no roster. Repeating the
   * frame is therefore also the heartbeat — `join` re-`put`s the member. The roster's answer is
   * read though nothing here can repair it: a dropped roster costs one heartbeat of blank room, and
   * the log is the only trace it leaves anywhere.
   */
  const joinPresence = async (socket: SyncSocket, name: Topic): Promise<void> => {
    if (!presence || options.hub.channelOf(name)?.channel.events !== true) return;
    const roster = await presence.join(name, { id: socket.id, actorId: socket.actorId });
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
        });
        if (socket.skewed) {
          socket.send({ type: 'update-available', v: PROTOCOL_VERSION, buildId: options.buildId });
        }
        return;
      }
      case 'subscribe': {
        if (frame.target.kind === 'channel') {
          // The topic is the DECLARATION's to spell (`channel.topic(params)`), so a drop finds it
          // by the sid its add was answered under — never by re-deriving it from client data.
          const topics = channelTopics.get(socket) ?? new Map<string, Topic>();
          channelTopics.set(socket, topics);
          if (frame.op === 'drop') {
            const name = topics.get(frame.sid);
            if (name === undefined) return;
            topics.delete(frame.sid);
            const events = options.hub.channelOf(name)?.channel.events === true;
            options.hub.unsubscribe(socket, name);
            if (presence && events) await presence.leave(name, socket.id);
            return;
          }
          const name = await options.hub.subscribeChannel(socket, frame.target);
          topics.set(frame.sid, name);
          await joinPresence(socket, name);
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
