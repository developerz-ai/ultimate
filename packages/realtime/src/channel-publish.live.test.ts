// An events-only channel across two PROCESSES and a real nats-server: the subscriber is a hub in
// this process (the `sync` role's half), the publisher a child process with nothing but the bus
// (a worker's half). No database and no replicator anywhere — that is the point.
//
// Skips unless a JetStream-enabled server is configured:
//
//   TEST_NATS_URL=nats://localhost:4222 bun test packages/realtime/src/channel-publish.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { ChannelHub } from './channel';
import { declareLiveFeed, LIVE_FEED_BUCKET } from './channel-publish-child-fixture';
import { clearChannels } from './channel-registry';
import { NatsTransport } from './nats-transport';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const url = Bun.env['TEST_NATS_URL'];

/** The preload freezes the clock, so waiting is counted in polls rather than in elapsed time. */
const waitFor = async (done: () => boolean, polls = 400): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(25);
};

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

const started: NatsTransport[] = [];

afterAll(async () => {
  for (const created of started) await created.close();
  clearChannels();
});

describe.skipIf(url === undefined)('an events-only channel across two processes', () => {
  test('a process holding only the bus publishes; a node in another process delivers it to its member', async () => {
    const feed = declareLiveFeed();
    const transport = new NatsTransport({ url: url ?? '', bucket: LIVE_FEED_BUCKET });
    started.push(transport);
    await transport.connect();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets });
    // Unique per run: the server is shared, and another run's event must not satisfy this one.
    const orgId = `org-${crypto.randomUUID()}`;
    const join = async (params: { orgId: string }): Promise<FakeWs> => {
      const ws = new FakeWs();
      const socket = new SyncSocket({
        ws,
        clientBuildId: 'build-1',
        serverBuildId: 'build-1',
        actor: null,
      });
      sockets.add(socket);
      await hub.subscribeChannel(socket, { kind: 'channel', channel: feed.name, params });
      return ws;
    };
    const member = await join({ orgId });
    const stranger = await join({ orgId: `${orgId}-other` });

    const child = Bun.spawn(
      ['bun', `${import.meta.dir}/channel-publish-child-fixture.ts`, url ?? '', orgId],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const code = await child.exited;
    expect({ code, stderr: await new Response(child.stderr).text() }).toEqual({
      code: 0,
      stderr: '',
    });

    const eventsOf = (ws: FakeWs): unknown[] =>
      ws.frames.flatMap((frame) => (frame.type === 'events' ? [frame.event] : []));
    await waitFor(() => eventsOf(member).length > 0);
    expect(eventsOf(member)).toEqual([{ kind: 'delivered', pid: child.pid }]);
    expect(child.pid).not.toBe(process.pid);
    expect(eventsOf(stranger)).toEqual([]);
    await hub.close();
  });
});
