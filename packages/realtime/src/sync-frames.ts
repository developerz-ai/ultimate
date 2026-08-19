// What a RECEIVED frame does to server state — the mirror of `client-frames.ts`, and the only
// inbound surface the `sync` node exposes. Every dependency is injected, so the router is
// exercisable without a socket, a bus or a server.

import { logger } from '@ultimat3/core';
import type { ChannelHub } from './channel';
import { topic as makeTopic } from './channel';
import { FrameRateLimitError } from './errors';
import { FrameLanes, laneKeyOf } from './frame-lanes';
import type { JsonValue, Row } from './json';
import type { LiveQueryRegistry } from './live-query';
import { type PresenceRegistry, presenceFrame } from './presence';
import { CLOSE, type SyncSocket } from './socket';
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

/**
 * What a failure ack refers to. `ack.ref` is how a client finds the thing that failed —
 * `queue.fail(frame.ref)` looks up a mutation by its idempotency key — so an ack built with the
 * SOCKET id names a key no queue can hold and the whole rollback path is inert end to end: the
 * optimistic write stays on screen and the mutation stays queued.
 *
 * The socket id is the answer for a frame nothing could read (a decode failure) and for the kinds
 * that carry no reference of their own, because there is nothing else true to say.
 */
export function ackRefOf(frame: Frame | null, socketId: string): string {
  if (frame === null) return socketId;
  if (frame.type === 'mutate') return frame.key;
  if (frame.type === 'subscribe') return frame.sid;
  return socketId;
}

export function createFrameRouter(options: FrameRouterOptions): FrameRouter {
  const presence = options.presence;
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
            // The answer is read even though nothing here can repair it. A roster has no cursor and
            // no re-send path of its own: the client renders an empty room until it repeats this
            // very frame as its heartbeat, which re-joins and re-rosters. Membership on the shared
            // set is already correct, so the drop costs one client one heartbeat of blank room —
            // and the log is the only trace it leaves anywhere.
            if (!socket.send(presenceFrame(name, 'sync', roster.members, roster.total))) {
              logger.warn('sync.presence_roster_dropped', { topic: name, socketId: socket.id });
            }
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
        // `subscribe` has already seated the subscription and cleared its desync mark, so a reply
        // the socket refuses leaves the server believing a client that holds no rows is in sync:
        // the next change reaches it as a PATCH folded onto nothing, forever, on a socket that has
        // since drained. Marked instead, which is the state it is actually in — the next delivery
        // re-snapshots it out of the shared window, exactly as `live-fanout` does for a lost patch.
        if (!socket.send(reply)) socket.markDesynced(frame.sid);
        return;
      }
      case 'mutate': {
        if (!options.onMutate) {
          // A failure receipt is still a receipt: dropped, the client's mutation stays `inflight`
          // and is neither rolled back nor retried, so this one reads the answer too.
          const sent = socket.send({
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
          if (!sent) undeliverable(socket, frame.key, 'ack');
          return;
        }
        const result = await options.onMutate({
          socket,
          name: frame.name,
          key: frame.key,
          seq: frame.seq,
          input: frame.input,
        });
        // The rebase FIRST, and the ack last. The ack is the receipt, and a receipt is what
        // retires the client's record of the mutation — its journal row and its rebase-log entry,
        // both of which stay forever otherwise. A rebase that lands after that has no entry left
        // to read the mutator's conflict strategy off (every merge silently becomes server-wins)
        // and no sequence to decide which later optimistic writes to replay over server truth.
        // These are two frames on one socket, so the order is the only coordination there is.
        if (result.entity !== undefined) {
          const sent = socket.send({
            type: 'rebase',
            v: PROTOCOL_VERSION,
            key: frame.key,
            entity: result.entity,
            strategy: 'server-wins',
            row: result.row ?? null,
          });
          // The ack retires the client's rebase-log entry, so acking a rebase that never left is
          // the divergence the ordering above exists to prevent — one frame later instead of one
          // frame earlier. Nothing is acked; the mutation stays unsettled and is replayed.
          if (!sent) return undeliverable(socket, frame.key, 'rebase');
        }
        if (
          !socket.send({
            type: 'ack',
            v: PROTOCOL_VERSION,
            ref: frame.key,
            lsn: result.lsn ?? null,
            error: null,
          })
        ) {
          undeliverable(socket, frame.key, 'ack');
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
  }
}

/**
 * A settlement the socket refused. There is nothing on the node to mark — the mutation is applied
 * and the server keeps no per-mutation state — and a client only returns an `inflight` mutation to
 * its queue when the connection dies (`requeueInflight`), so a receipt dropped on a socket that
 * stays up is a write the client neither retires nor retries, with the server believing it settled.
 * Closing IS the repair: the queue hands the mutation back and the reconnect replays it under the
 * same idempotency key.
 */
function undeliverable(socket: SyncSocket, key: string, kind: 'rebase' | 'ack'): void {
  logger.warn('sync.settlement_dropped', { socketId: socket.id, key, kind });
  socket.close(CLOSE.overloaded, 'settlement undeliverable');
}
