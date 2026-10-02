// A channel seat is keyed by its TOPIC, never by the sid the client chose for it, and a sid has a
// ceiling: both were the client's to grow without bound on one authenticated socket.

import { afterAll, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import { ChannelSids } from './channel-sids';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { ackRefOf, createFrameRouter, MAX_SID_LENGTH } from './sync-frames';
import { decode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const room = channel('frames-room', {
  params: ['orgId'],
  catchUp: { name: 'roomRead' },
  policy: {
    kind: 'allow',
    label: 'public',
    permissions: [],
    children: [],
    run: () => ({ allowed: true }),
  },
});
afterAll(() => {
  clearChannels();
});

const ws: WsLike = {
  send: (data: string) => data.length,
  close: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
  getBufferedAmount: () => 0,
};

function rig() {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
  const channelSids = new ChannelSids();
  const route = createFrameRouter({
    hub,
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    buildId: 'b',
    channelSids,
  });
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id: 'alice', orgId: 'o1' }),
    maxFramesPerSecond: 100_000,
    frameBurst: 100_000,
  });
  sockets.add(socket);
  return { hub, socket, channelSids, route };
}

const frame = (op: 'add' | 'drop', sid: string): Frame => ({
  type: 'subscribe',
  v: PROTOCOL_VERSION,
  op,
  sid,
  target: { kind: 'channel', channel: 'frames-room', params: { orgId: 'o1' } },
});

describe('a channel seat is keyed by its topic', () => {
  test('two sids naming one topic are one membership: dropping the stale one keeps the seat', async () => {
    const { socket, route } = rig();
    const name = room.topic({ orgId: 'o1' });
    await route(socket, frame('add', 'sid-a'));
    await route(socket, frame('add', 'sid-b'));

    await route(socket, frame('drop', 'sid-a'));
    expect(socket.topics.has(name)).toBe(true);

    await route(socket, frame('drop', 'sid-b'));
    expect(socket.topics.has(name)).toBe(false);
  });

  test('fresh sids for one topic retain one entry, not one each', async () => {
    const { socket, channelSids, route } = rig();
    for (let n = 0; n < 500; n += 1) await route(socket, frame('add', `sid-${n}`));

    expect(channelSids.count(socket)).toBe(1);
    expect(channelSids.sidOf(socket, room.topic({ orgId: 'o1' }))).toBe('sid-499');
  });
});

describe('a sid has a ceiling', () => {
  const long = 'x'.repeat(MAX_SID_LENGTH + 1);

  test('a channel subscribe past it is refused before anything is seated', async () => {
    const { socket, channelSids, route } = rig();

    await expect(route(socket, frame('add', long))).rejects.toBeUltimateError('X_PROTOCOL_VERSION');
    expect(socket.topics.size).toBe(0);
    expect(channelSids.count(socket)).toBe(0);
  });

  test('a live-query subscribe past it is refused too', async () => {
    const { socket, route } = rig();

    await expect(
      route(socket, {
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: long,
        target: { kind: 'query', qid: 'anything', input: null, cursor: null },
      }),
    ).rejects.toBeUltimateError('X_PROTOCOL_VERSION');
  });

  test('the refusal never echoes it: the ack names the socket', () => {
    expect(ackRefOf(frame('add', long), 'sock-1')).toBe('sock-1');
    expect(ackRefOf(frame('add', 'sid-1'), 'sock-1')).toBe('sid-1');
  });

  test('a sid AT the ceiling is accepted', async () => {
    const { socket, route } = rig();
    await route(socket, frame('add', 'x'.repeat(MAX_SID_LENGTH)));
    expect(socket.topics.size).toBe(1);
  });
});

// An events-only channel is answered with nothing but its roster. On a node built with no
// presence registry nothing answered at all, and the subscriber read `joining` until an app event.
describe('an events channel on a node with no presence', () => {
  channel('frames-typing', {
    params: ['orgId'],
    catchUp: { name: 'typingRead' },
    policy: {
      kind: 'allow',
      label: 'public',
      permissions: [],
      children: [],
      run: () => ({ allowed: true }),
    },
    events: true,
  });

  test('is answered with the roster this node can vouch for: nobody', async () => {
    const sent: Frame[] = [];
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
    const route = createFrameRouter({
      hub,
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
      buildId: 'b',
    });
    const socket = new SyncSocket({
      ws: { ...ws, send: (data: string) => sent.push(decode(data)) },
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor: userActor({ id: 'alice', orgId: 'o1' }),
    });
    sockets.add(socket);

    await route(socket, {
      type: 'subscribe',
      v: PROTOCOL_VERSION,
      op: 'add',
      sid: 'c-1',
      target: { kind: 'channel', channel: 'frames-typing', params: { orgId: 'o1' } },
    });

    expect(sent).toEqual([
      {
        type: 'events',
        v: PROTOCOL_VERSION,
        channel: 'frames-typing.o1',
        event: { presence: 'sync', members: [], total: 0 },
      },
    ]);
  });

  test('a records-only channel is still sent no roster', async () => {
    const { socket, route } = rig();
    const sent: number[] = [];
    const original = socket.send.bind(socket);
    socket.send = (frame) => {
      if (frame.type === 'events') sent.push(1);
      return original(frame);
    };
    await route(socket, frame('add', 'sid-a'));
    expect(sent).toEqual([]);
  });
});

describe('the hello reply names the beat', () => {
  test('heartbeatMs rides the reply when the node was given one, and is absent otherwise', async () => {
    const answers = async (heartbeatMs?: number): Promise<Frame | undefined> => {
      const sent: Frame[] = [];
      const sockets = new SocketRegistry();
      const route = createFrameRouter({
        hub: new ChannelHub({ transport: new InProcessTransport(), sockets }),
        registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
        buildId: 'b',
        ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
      });
      const socket = new SyncSocket({
        ws: { ...ws, send: (data: string) => sent.push(decode(data)) },
        clientBuildId: 'b',
        serverBuildId: 'b',
        actor: null,
      });
      await route(socket, {
        type: 'hello',
        v: PROTOCOL_VERSION,
        buildId: 'b',
        sessionId: null,
        actorId: null,
      });
      return sent[0];
    };

    expect(await answers(3_000)).toMatchObject({ type: 'hello', heartbeatMs: 3_000 });
    const silent = await answers();
    expect(silent?.type).toBe('hello');
    expect(silent !== undefined && 'heartbeatMs' in silent).toBe(false);
  });
});

describe('a beat on a suspended seat', () => {
  let broken = false;
  channel('frames-guarded', {
    params: ['orgId'],
    catchUp: { name: 'guardedRead' },
    events: true,
    policy: {
      kind: 'allow',
      label: 'guarded',
      permissions: [],
      children: [],
      run: () => {
        if (broken) throw Object.assign(new Error('pool exhausted'), { code: 'X_DB_TIMEOUT' });
        return { allowed: true };
      },
    },
  });

  test('is sent no roster: a suspension withholds every delivery on the topic', async () => {
    const sent: Frame[] = [];
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
    const route = createFrameRouter({
      hub,
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
      buildId: 'b',
    });
    const actor = userActor({ id: 'alice', orgId: 'o1' });
    const socket = new SyncSocket({
      ws: { ...ws, send: (data: string) => sent.push(decode(data)) },
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor,
    });
    sockets.add(socket);
    const add: Frame = {
      type: 'subscribe',
      v: PROTOCOL_VERSION,
      op: 'add',
      sid: 'c-1',
      target: { kind: 'channel', channel: 'frames-guarded', params: { orgId: 'o1' } },
    };
    await route(socket, add);
    expect(sent).toHaveLength(1);

    broken = true;
    await hub.onActorChange(socket, actor);
    await route(socket, add);
    expect(sent).toHaveLength(1);

    broken = false;
    await route(socket, add);
    await route(socket, add);
    expect(sent.length).toBeGreaterThan(1);
  });
});

describe('a re-ask that DENIES a suspended seat', () => {
  let mode: 'allow' | 'broken' | 'deny' = 'allow';
  channel('frames-revocable', {
    params: ['orgId'],
    catchUp: { name: 'revocableRead' },
    policy: {
      kind: 'allow',
      label: 'revocable',
      permissions: [],
      children: [],
      run: () => {
        if (mode === 'broken') throw Object.assign(new Error('pool'), { code: 'X_DB_TIMEOUT' });
        return mode === 'allow'
          ? { allowed: true }
          : { allowed: false, reason: 'revoked', code: 'X_FORBIDDEN' };
      },
    },
  });

  test('is refused to the client, and the sid no longer names the seat', async () => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
    const channelSids = new ChannelSids();
    const route = createFrameRouter({
      hub,
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
      buildId: 'b',
      channelSids,
    });
    const actor = userActor({ id: 'alice', orgId: 'o1' });
    const socket = new SyncSocket({ ws, clientBuildId: 'b', serverBuildId: 'b', actor });
    sockets.add(socket);
    const add: Frame = {
      type: 'subscribe',
      v: PROTOCOL_VERSION,
      op: 'add',
      sid: 'c-1',
      target: { kind: 'channel', channel: 'frames-revocable', params: { orgId: 'o1' } },
    };
    await route(socket, add);
    mode = 'broken';
    await hub.onActorChange(socket, actor);
    expect(channelSids.count(socket)).toBe(1);

    mode = 'deny';
    await expect(route(socket, add)).rejects.toBeUltimateError('X_TOPIC_FORBIDDEN');

    expect(channelSids.count(socket)).toBe(0);
    expect(hub.topicsOf(socket)).toEqual([]);
    mode = 'allow';
  });
});
