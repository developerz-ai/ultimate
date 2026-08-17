// What local delivery owes the node it runs on: a count for the frames it drops, one delivery
// mechanism rather than two, and a socket table whose exit is the one definition of "gone".

import { beforeEach, describe, expect, test } from 'bun:test';
import { collectMetrics, resetMetrics } from '@ultimat3/core';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

/** Backpressure is a property of the connection, so the fake owns it exactly as Bun's socket does. */
class FakeWs implements WsLike {
  readonly sent: string[] = [];
  readonly subscribed: string[] = [];
  buffered = 0;
  send(data: string): number {
    this.sent.push(data);
    return data.length;
  }
  close(): void {}
  subscribe(name: string): void {
    this.subscribed.push(name);
  }
  unsubscribe(name: string): void {
    this.subscribed.push(`-${name}`);
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
}

const TOPIC = 'org.o1.cursors';

const channelFrame = (): Frame => ({
  type: 'patch',
  v: PROTOCOL_VERSION,
  sid: TOPIC,
  lsn: '1',
  patches: [{ op: 'insert', id: '1', row: { x: 1 }, lsn: '1' }],
});

function socketOn(registry: SocketRegistry, id: string): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    maxBufferedBytes: 16,
  });
  registry.add(socket);
  return { socket, ws };
}

/** What a scrape would read, straight off the collector — not an internal counter of our own. */
function droppedSeries(): { value: number; attributes: Record<string, unknown> } | undefined {
  const metric = collectMetrics().metrics.find(
    (each) => each.descriptor.name === 'channel_frames_dropped_total',
  );
  const point = metric?.points[0];
  return point === undefined ? undefined : { value: point.value, attributes: point.attributes };
}

beforeEach(() => {
  resetMetrics();
});

describe('a dropped channel frame is counted', () => {
  test('a topic delivery refused by backpressure ticks the node counter', () => {
    const registry = new SocketRegistry();
    const slow = socketOn(registry, 'slow');
    const fast = socketOn(registry, 'fast');
    registry.joinTopic(slow.socket, TOPIC);
    registry.joinTopic(fast.socket, TOPIC);
    slow.ws.buffered = 1_024;

    expect(registry.deliver(TOPIC, channelFrame())).toBe(1);

    // A channel has no cursor, no `desynced` mark and no re-snapshot: this frame is gone for good
    // and the counter is the only thing that will ever say so.
    expect(registry.droppedChannelFrames).toBe(1);
    expect(slow.ws.sent).toHaveLength(0);
    expect(fast.ws.sent).toHaveLength(1);
  });

  test('a delivery every socket took counts nothing', () => {
    const registry = new SocketRegistry();
    const one = socketOn(registry, 'one');
    registry.joinTopic(one.socket, TOPIC);

    registry.deliver(TOPIC, channelFrame());

    expect(registry.droppedChannelFrames).toBe(0);
  });

  test('the count is cumulative across topics and deliveries', () => {
    const registry = new SocketRegistry();
    const slow = socketOn(registry, 'slow');
    registry.joinTopic(slow.socket, TOPIC);
    registry.joinTopic(slow.socket, 'org.o1.typing');
    slow.ws.buffered = 1_024;

    registry.deliver(TOPIC, channelFrame());
    registry.deliver('org.o1.typing', channelFrame());

    expect(registry.droppedChannelFrames).toBe(2);
  });

  test('it reaches the metric a scrape reads, with no per-topic label to explode', () => {
    const registry = new SocketRegistry();
    const slow = socketOn(registry, 'slow');
    registry.joinTopic(slow.socket, TOPIC);
    registry.joinTopic(slow.socket, 'org.o1.typing');
    slow.ws.buffered = 1_024;

    registry.deliver(TOPIC, channelFrame());
    registry.deliver('org.o1.typing', channelFrame());

    // A counter nobody can alert on is a counter that does not exist — and a topic is client-chosen,
    // so one series per topic is a cardinality bomb one socket can mint at will.
    expect(droppedSeries()?.value).toBe(2);
    expect(droppedSeries()?.attributes).toEqual({});
    expect(
      collectMetrics().metrics.find((m) => m.descriptor.name === 'channel_frames_dropped_total')
        ?.descriptor.kind,
    ).toBe('counter');
  });

  test('a node that dropped nothing publishes no point at all', () => {
    const registry = new SocketRegistry();
    const one = socketOn(registry, 'one');
    registry.joinTopic(one.socket, TOPIC);

    registry.deliver(TOPIC, channelFrame());

    expect(droppedSeries()).toBeUndefined();
  });
});

describe('the socket table is the definition of a live connection', () => {
  test('removing a socket marks it closed, so an in-flight subscribe can see it is gone', () => {
    const registry = new SocketRegistry();
    const { socket } = socketOn(registry, 'a');
    expect(socket.closed).toBe(false);

    // The node's `close` callback: the connection is already gone, so nothing calls `close()` on
    // this object — and a subscribe still awaiting its snapshot read has only this to ask.
    registry.remove('a');

    expect(socket.closed).toBe(true);
    expect(socket.send(channelFrame())).toBe(false);
  });
});

describe('one delivery mechanism, not two', () => {
  test("joining a topic does not also register it with Bun's native pub/sub", () => {
    const registry = new SocketRegistry();
    const { socket, ws } = socketOn(registry, 'a');

    registry.joinTopic(socket, TOPIC);
    registry.deliver(TOPIC, channelFrame());
    registry.leaveTopic(socket, TOPIC);

    // Nothing in this framework publishes to a native topic — every channel frame is written per
    // socket through `send`, which is what counts a drop, closes an overloaded socket and lets the
    // live path mark a subscriber desynced. A second membership nothing reads is a second index to
    // keep right, per socket per topic, at 50,000 sockets.
    expect(ws.subscribed).toEqual([]);
    expect(socket.topics.size).toBe(0);
    expect(ws.sent).toHaveLength(1);
  });
});
