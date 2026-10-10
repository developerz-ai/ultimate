import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { allow } from '@ultimat3/policy';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { publishChannelEvent, resetChannelTransport, setChannelTransport } from './channel-publish';
import { clearChannels } from './channel-registry';
import { InProcessTransport } from './fanout';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

/** A `sync` node's half: a hub on `transport`, and one socket joined to `feed.<orgId>`. */
async function member(transport: InProcessTransport, orgId: string): Promise<FakeWs> {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport, sockets });
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: null,
  });
  sockets.add(socket);
  await hub.subscribeChannel(socket, { kind: 'channel', channel: 'feed', params: { orgId } });
  return ws;
}

const eventsOf = (ws: FakeWs): unknown[] =>
  ws.frames.flatMap((frame) => (frame.type === 'events' ? [frame.event] : []));

/** Events only: no `records`, so nothing here ever needs a change feed or a replicator. */
const feed = channel('feed', {
  params: ['orgId'],
  catchUp: { name: 'feedRead' },
  events: true,
  policy: allow('public'),
});

const quiet = channel('quiet', {
  params: ['orgId'],
  catchUp: { name: 'quietRead' },
  policy: allow('public'),
});

afterEach(() => {
  resetChannelTransport();
});

afterAll(() => {
  clearChannels();
});

describe('publishChannelEvent', () => {
  test('a process with no hub publishes onto the bus the boot installed, and a node delivers it', async () => {
    const bus = new InProcessTransport();
    const ws = await member(bus, 'o1');
    const other = await member(bus, 'o2');
    // The worker's half: no hub, no socket registry — only the transport the boot handed over.
    setChannelTransport(bus);

    await publishChannelEvent(feed, { orgId: 'o1' }, { kind: 'delivered', id: 'n1' });

    expect(eventsOf(ws)).toEqual([{ kind: 'delivered', id: 'n1' }]);
    expect(eventsOf(other)).toEqual([]);
  });

  test('the frame is the one a hub publishes, on the same subject', async () => {
    const bus = new InProcessTransport();
    const seen: string[] = [];
    await bus.subscribe('x.channel.>', (payload, subject) => {
      seen.push(`${subject} ${payload}`);
    });
    setChannelTransport(bus);

    await publishChannelEvent(feed, { orgId: 'o1' }, { n: 1 });
    await new ChannelHub({ transport: bus, sockets: new SocketRegistry() }).publishEvent(
      feed,
      { orgId: 'o1' },
      { n: 1 },
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toStartWith('x.channel.feed.o1 ');
  });

  test('with nothing installed it reaches nobody and does not throw — a unit test, a one-off script', async () => {
    const bus = new InProcessTransport();
    const ws = await member(bus, 'o1');
    await publishChannelEvent(feed, { orgId: 'o1' }, { n: 1 });
    expect(eventsOf(ws)).toEqual([]);
  });

  test('the release a boot holds puts the heap bus back, and only for its own install', async () => {
    const first = new InProcessTransport();
    const second = new InProcessTransport();
    const ws = await member(first, 'o1');
    const release = setChannelTransport(first);
    setChannelTransport(second);
    // A stale release — the first boot's, after a second boot installed its own — changes nothing.
    release();
    const later = await member(second, 'o1');
    await publishChannelEvent(feed, { orgId: 'o1' }, { n: 2 });
    expect(eventsOf(ws)).toEqual([]);
    expect(eventsOf(later)).toEqual([{ n: 2 }]);
  });

  test('a channel declared without events refuses, as the hub does', async () => {
    await expect(publishChannelEvent(quiet, { orgId: 'o1' }, { n: 1 })).rejects.toMatchObject({
      code: 'X_CHANNEL_DECLARATION_INVALID',
    });
  });

  test('a param that is no topic segment refuses before anything is sent', async () => {
    await expect(publishChannelEvent(feed, { orgId: 'o1.>' }, { n: 1 })).rejects.toMatchObject({
      code: 'X_TOPIC_FORBIDDEN',
    });
  });
});
