// What a socket's re-decided grant does to it: the hub re-asks every channel seat under the new
// actor (each one it drops is refused under its sid, and left in presence), and the registry
// re-decides every live subscription. Split from `sync-node.ts` at its size ceiling.

import type { Actor } from '@ultimat3/core';
import type { ChannelHub, Topic } from './channel';
import type { ChannelSids } from './channel-sids';
import { detach } from './detach';
import { TopicForbiddenError } from './errors';
import type { LiveQueryRegistry } from './live-query';
import { refuseSubscription } from './live-refusal';
import type { PresenceRegistry } from './presence';
import type { SocketRegistry } from './socket';

export interface ActorChangeDeps {
  readonly sockets: SocketRegistry;
  readonly hub: ChannelHub;
  readonly registry: LiveQueryRegistry;
  readonly channelSids: ChannelSids;
  readonly presence: PresenceRegistry | undefined;
}

/** The `onActor` a grant sweep calls once per socket whose grant was refreshed. */
export function actorChangeHandler(
  deps: ActorChangeDeps,
): (socketId: string, actor: Actor) => Promise<void> {
  const hasRoster = (name: Topic): boolean => deps.hub.channelOf(name)?.channel.events === true;
  return async (socketId, actor) => {
    const socket = deps.sockets.get(socketId);
    if (!socket) return;
    const rooms = new Set(deps.hub.topicsOf(socket).filter(hasRoster));
    // The hub sets `socket.actor` and drops the topics this actor may no longer read; the
    // registry re-decides every live subscription (refusing each one it drops under its sid)
    // and desyncs the survivors, so the next delivery re-snapshots them under the new
    // authority rather than the old window.
    for (const name of await deps.hub.onActorChange(socket, actor)) {
      // A dropped seat is SAID: unsaid, the client kept rendering the channel as live.
      const sid = deps.channelSids.sidOf(socket, name);
      deps.channelSids.delete(socket, name);
      if (sid !== undefined) {
        refuseSubscription(
          socket,
          sid,
          new TopicForbiddenError({
            topic: name,
            actorId: socket.actorId,
            reason: 'the session changed and the channel policy no longer admits it',
          }),
        );
      }
      if (deps.presence && rooms.has(name))
        detach(deps.presence.leave(name, socket.id), 'presence.leave', name);
    }
    await deps.registry.reauthorize(socket);
  };
}
