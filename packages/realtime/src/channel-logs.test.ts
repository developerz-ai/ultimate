// `ChannelLogs.resume` — what a (re)subscribe is ANSWERED with. Every answer is something the
// client can turn into `live`: frames, a `replay-gap`, or — for a resume that was already current —
// the frame at its own cursor, carrying nothing.

import { afterAll, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { channel } from './channel-decl';
import { ChannelLogs } from './channel-logs';
import { clearChannels } from './channel-registry';
import { OPEN_POLICY } from './policy-fake';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';

const posts = entity('channel_logs_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text() },
});
const feed = channel('logs-feed', {
  params: ['orgId'],
  catchUp: { name: 'logsFeed' },
  policy: OPEN_POLICY,
  records: [posts],
});

afterAll(() => {
  clearRegistry();
  clearChannels();
});

type Wire = { readonly type: string } & Record<string, unknown>;

class FakeWs implements WsLike {
  readonly frames: Wire[] = [];
  buffered = 0;
  send(data: string): number {
    this.frames.push(JSON.parse(data) as Wire);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
}

const TOPIC = 'logs-feed.o1';

function seated(): { logs: ChannelLogs; socket: SyncSocket; ws: FakeWs; epoch: string } {
  const sockets = new SocketRegistry();
  const logs = new ChannelLogs(sockets, 4);
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id: 'alice' }),
    maxBufferedBytes: 10,
    maxDroppedFrames: 100,
  });
  sockets.add(socket);
  const ring = logs.open(TOPIC, { channel: feed, params: { orgId: 'o1' } });
  for (const id of ['p1', 'p2']) {
    ring.append([{ type: 'channel_logs_posts', key: id, row: { id, orgId: 'o1', title: id } }], []);
  }
  return { logs, socket, ws, epoch: ring.epoch };
}

describe('resume', () => {
  test('a resume that is already CURRENT is answered: the frame at its cursor, carrying nothing', () => {
    const { logs, socket, ws, epoch } = seated();
    logs.resume(socket, TOPIC, { epoch, seq: 2 }, true);
    expect(ws.frames).toEqual([{ type: 'records', v: 3, channel: TOPIC, seq: 2, epoch }]);
  });

  test('…on a seat that is not fresh too: the question was asked, so it is answered', () => {
    const { logs, socket, ws, epoch } = seated();
    logs.resume(socket, TOPIC, { epoch, seq: 2 }, false);
    expect(ws.frames.map((frame) => frame.type)).toEqual(['records']);
  });

  test('a resume BEHIND gets exactly what it missed, and no extra frame', () => {
    const { logs, socket, ws, epoch } = seated();
    logs.resume(socket, TOPIC, { epoch, seq: 1 }, true);
    expect(ws.frames.map((frame) => [frame.type, frame['seq']])).toEqual([['records', 2]]);
    expect(ws.frames[0]).toHaveProperty('adopt');
  });

  test('the presence beat — no since, a seat already taken — is still sent nothing', () => {
    const { logs, socket, ws } = seated();
    logs.resume(socket, TOPIC, undefined, false);
    expect(ws.frames).toEqual([]);
  });

  test('a current answer backpressure refused is owed as a replay-gap', () => {
    const { logs, socket, ws, epoch } = seated();
    ws.buffered = 1_000;
    logs.resume(socket, TOPIC, { epoch, seq: 2 }, true);
    expect(ws.frames).toEqual([]);
    expect(socket.gaps.get(TOPIC)).toBe(epoch);
  });
});
