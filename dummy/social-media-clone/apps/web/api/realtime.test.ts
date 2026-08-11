// live — the channel guards, run against a REAL `ChannelHub` over a real transport and socket
// registry. Asserting the predicates in isolation would prove they return false; this proves the
// hub refuses the subscribe, which is the thing that matters.
//
// Deny by default is the property under test: a topic with no matching guard must throw, so a
// pattern nobody declared can never become an accidental broadcast.

import { db } from '@social-media-clone/db';
import { userActor } from '@ultimat3/core';
import type { WsLike } from '@ultimat3/realtime';
import {
  ChannelHub,
  InProcessTransport,
  SocketRegistry,
  SyncSocket,
  topic,
} from '@ultimat3/realtime';
import { expect, liveTest } from '@ultimat3/testing';
import { addParticipant } from '../app/messages/repo';
import { conversationTopic, inboxTopic, installRealtimeTopics } from './realtime';

const ADA = '00000000-0000-4000-8000-0000000000a4';
const MARA = '00000000-0000-4000-8000-0000000000c4';
const ROOM = '00000000-0000-4000-8000-0000000000f4';

const seeded = (async () => {
  await db.conversations.insert({ id: ROOM, kind: 'direct' });
  await addParticipant(ROOM, ADA);
})();

interface Rig {
  readonly hub: ChannelHub;
  socketFor(id: string | null): SyncSocket;
}

/** `WsLike` is structural precisely so a guard test needs no server. Nothing here is sent. */
const nullWs = (): WsLike => ({
  send: () => 0,
  close: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
  getBufferedAmount: () => 0,
});

const rig = (): Rig => {
  const sockets = new SocketRegistry();
  const hub = installRealtimeTopics(
    new ChannelHub({ transport: new InProcessTransport(), sockets }),
  );
  let seq = 0;
  return {
    hub,
    socketFor: (id) => {
      seq += 1;
      const socket = new SyncSocket({
        id: `socket-${seq}`,
        ws: nullWs(),
        clientBuildId: 'test',
        serverBuildId: 'test',
        actor: id === null ? null : userActor({ id }),
      });
      sockets.add(socket);
      return socket;
    },
  };
};

liveTest('a non-participant is refused the conversation topic', async () => {
  await seeded;
  const { hub, socketFor } = rig();
  await expect(hub.subscribe(socketFor(MARA), conversationTopic(ROOM))).rejects.toThrow(
    /X_TOPIC_FORBIDDEN/,
  );
});

liveTest('a participant is admitted, so the refusal above is about membership', async () => {
  await seeded;
  const { hub, socketFor } = rig();
  const socket = socketFor(ADA);
  await hub.subscribe(socket, conversationTopic(ROOM));
  expect(socket.topics.has(conversationTopic(ROOM))).toBe(true);
});

liveTest('an anonymous socket is refused a conversation it cannot be a member of', async () => {
  await seeded;
  const { hub, socketFor } = rig();
  await expect(hub.subscribe(socketFor(null), conversationTopic(ROOM))).rejects.toThrow(
    /X_TOPIC_FORBIDDEN/,
  );
});

liveTest(
  'a conversation that does not exist refuses exactly like one that is not yours',
  async () => {
    await seeded;
    const { hub, socketFor } = rig();
    const absent = '00000000-0000-4000-8000-0000000000f8';
    await expect(hub.subscribe(socketFor(ADA), conversationTopic(absent))).rejects.toThrow(
      /X_TOPIC_FORBIDDEN/,
    );
  },
);

liveTest('an inbox belongs to exactly one person', async () => {
  const { hub, socketFor } = rig();
  await hub.subscribe(socketFor(ADA), inboxTopic(ADA));
  await expect(hub.subscribe(socketFor(MARA), inboxTopic(ADA))).rejects.toThrow(
    /X_TOPIC_FORBIDDEN/,
  );
});

liveTest('a topic nobody declared a guard for is DENIED, not broadcast', async () => {
  const { hub, socketFor } = rig();
  // The whole point of deny-by-default: an authz hole must not be a pattern somebody forgot.
  await expect(hub.subscribe(socketFor(ADA), topic('presence', ROOM))).rejects.toThrow(
    /X_TOPIC_FORBIDDEN/,
  );
});
