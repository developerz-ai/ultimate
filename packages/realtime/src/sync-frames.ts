// What a RECEIVED frame does to server state — the mirror of `client-frames.ts`, and the only
// inbound surface the `sync` node exposes. Every dependency is injected, so the router is
// exercisable without a socket, a bus or a server.

import type { ChannelHub } from './channel';
import { topic as makeTopic } from './channel';
import { FrameRateLimitError } from './errors';
import type { JsonValue, Row } from './json';
import type { LiveQueryRegistry } from './live-query';
import { type PresenceRegistry, presenceFrame } from './presence';
import type { SyncSocket } from './socket';
import { type Frame, PROTOCOL_VERSION, toWireError } from './sync-protocol';

/** Server-authoritative mutation execution. Injected: `sync` never owns business logic. */
export type MutationHandler = (args: {
  socket: SyncSocket;
  name: string;
  key: string;
  seq: number;
  input: JsonValue;
}) => Promise<{ lsn?: string | null; entity?: string; row?: Row | null }>;

export interface FrameRouterOptions {
  readonly hub: ChannelHub;
  readonly registry: LiveQueryRegistry;
  readonly buildId: string;
  readonly presence?: PresenceRegistry | undefined;
  readonly onMutate?: MutationHandler | undefined;
}

export type FrameRouter = (socket: SyncSocket, frame: Frame) => Promise<void>;

export function createFrameRouter(options: FrameRouterOptions): FrameRouter {
  const presence = options.presence;

  return async function routeFrame(socket: SyncSocket, frame: Frame): Promise<void> {
    // Before `touch()` and before every amplifier below it: a frame this node refuses to route
    // must not also renew the idle window that would otherwise close a flooding socket.
    if (!socket.frameBudget.tryAccept()) {
      throw new FrameRateLimitError({
        socketId: socket.id,
        perSecond: socket.frameBudget.perSecond,
      });
    }
    socket.touch();
    switch (frame.type) {
      case 'hello': {
        socket.send({
          type: 'hello',
          v: PROTOCOL_VERSION,
          buildId: options.buildId,
          sessionId: socket.id,
          // The actor the upgrade resolved, so a client can render who the server thinks it is
          // rather than who it thinks it sent.
          actorId: socket.actorId,
          resume: [],
        });
        if (socket.skewed) {
          socket.send({ type: 'update-available', v: PROTOCOL_VERSION, buildId: options.buildId });
        }
        return;
      }
      case 'subscribe': {
        if (frame.target.kind === 'topic') {
          const name = makeTopic(...frame.target.topic.split('.'));
          if (frame.op === 'drop') {
            options.hub.unsubscribe(socket, name);
            if (presence) await presence.leave(name, socket.id);
            return;
          }
          await options.hub.subscribe(socket, name);
          // Subscribing to a topic IS joining its presence set: presence has no frame of its own,
          // so a second round trip saying "and I am here" would be a second way to do one thing,
          // and a client that skipped it would be invisible in a room it is receiving from.
          // Repeating the frame is therefore also the heartbeat — `join` re-`put`s the member.
          if (presence) {
            const roster = await presence.join(name, { id: socket.id, actorId: socket.actorId });
            socket.send(presenceFrame(name, 'sync', roster.members, roster.total));
          }
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
        socket.send(reply);
        return;
      }
      case 'mutate': {
        if (!options.onMutate) {
          socket.send({
            type: 'ack',
            v: PROTOCOL_VERSION,
            ref: frame.key,
            lsn: null,
            error: toWireError({
              code: 'X_NOT_IMPLEMENTED',
              cause: 'this sync node was started without a mutation handler',
              fix: 'pass onMutate to createSyncNode({ onMutate })',
            }),
          });
          return;
        }
        const result = await options.onMutate({
          socket,
          name: frame.name,
          key: frame.key,
          seq: frame.seq,
          input: frame.input,
        });
        socket.send({
          type: 'ack',
          v: PROTOCOL_VERSION,
          ref: frame.key,
          lsn: result.lsn ?? null,
          error: null,
        });
        if (result.entity !== undefined) {
          socket.send({
            type: 'rebase',
            v: PROTOCOL_VERSION,
            key: frame.key,
            entity: result.entity,
            strategy: 'server-wins',
            row: result.row ?? null,
          });
        }
        return;
      }
      // Server-authored frames are never received from a client.
      case 'snapshot':
      case 'patch':
      case 'ack':
      case 'rebase':
      case 'presence':
      case 'reconnect':
      case 'update-available':
        return;
    }
  };
}
