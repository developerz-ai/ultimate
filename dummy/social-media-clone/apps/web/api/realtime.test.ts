// live — the app's channel declarations, run against a REAL `ChannelHub` over a real transport and
// socket registry. Asserting the predicates in isolation would prove they return false; this proves
// the hub refuses the subscribe, which is the thing that matters.
//
// Deny by default is the property under test: a channel nobody declared must throw, so a name
// nobody wrote can never become an accidental broadcast.

import { db } from '@social-media-clone/db';
import { type Actor, userActor } from '@ultimat3/core';
import type { WsLike } from '@ultimat3/realtime/server';
import {
  ChannelHub,
  InProcessTransport,
  SocketRegistry,
  SyncSocket,
} from '@ultimat3/realtime/server';
import { expect, liveTest } from '@ultimat3/testing';
import { addParticipant } from '../app/messages/repo';
// Imported for the registration: `channel()` registers on import, exactly as the app loader's scan
// imports these modules at boot — so the hub below is built with no list, the way a host builds it.
import '../app/messages/topics';
import '../app/notifications/topics';

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

/** `WsLike` is structural precisely so a channel test needs no server. Nothing here is sent. */
const nullWs = (): WsLike => ({
  send: () => 0,
  close: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
  getBufferedAmount: () => 0,
});

/** Every signed-in socket holds both read grants: what is under test is membership and identity. */
const member = (id: string): Actor => ({
  ...userActor({ id }),
  permissions: ['message:read', 'notification:read'],
});

const rig = (): Rig => {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
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
        actor: id === null ? null : member(id),
      });
      sockets.add(socket);
      return socket;
    },
  };
};

const conversation = (conversationId: string) =>
  ({ kind: 'channel', channel: 'messages', params: { conversationId } }) as const;
const inbox = (userId: string) =>
  ({ kind: 'channel', channel: 'notifications', params: { userId } }) as const;

liveTest('a non-participant is refused the conversation channel', async () => {
  await seeded;
  const { hub, socketFor } = rig();
  await expect(hub.subscribeChannel(socketFor(MARA), conversation(ROOM))).rejects.toThrow(
    /X_TOPIC_FORBIDDEN/,
  );
});

liveTest('a participant is admitted, so the refusal above is about membership', async () => {
  await seeded;
  const { hub, socketFor } = rig();
  const socket = socketFor(ADA);
  const topic = await hub.subscribeChannel(socket, conversation(ROOM));
  expect(socket.topics.has(topic)).toBe(true);
});

liveTest('an anonymous socket is refused a conversation it cannot be a member of', async () => {
  await seeded;
  const { hub, socketFor } = rig();
  await expect(hub.subscribeChannel(socketFor(null), conversation(ROOM))).rejects.toThrow(
    /X_TOPIC_FORBIDDEN/,
  );
});

liveTest(
  'a conversation that does not exist refuses exactly like one that is not yours',
  async () => {
    await seeded;
    const { hub, socketFor } = rig();
    const absent = '00000000-0000-4000-8000-0000000000f8';
    await expect(hub.subscribeChannel(socketFor(ADA), conversation(absent))).rejects.toThrow(
      /X_TOPIC_FORBIDDEN/,
    );
  },
);

liveTest('an inbox belongs to exactly one person', async () => {
  const { hub, socketFor } = rig();
  await hub.subscribeChannel(socketFor(ADA), inbox(ADA));
  await expect(hub.subscribeChannel(socketFor(MARA), inbox(ADA))).rejects.toThrow(
    /X_TOPIC_FORBIDDEN/,
  );
});

liveTest('a channel nobody declared is DENIED, not broadcast', async () => {
  const { hub, socketFor } = rig();
  // The whole point of deny-by-default: an authz hole must not be a name somebody forgot.
  await expect(
    hub.subscribeChannel(socketFor(ADA), {
      kind: 'channel',
      channel: 'presence',
      params: { conversationId: ROOM },
    }),
  ).rejects.toThrow(/X_TOPIC_FORBIDDEN/);
});
