// What the node owes a socket it evicts ITSELF. Bun's `close` callback runs `teardown`; a drain and
// the idle sweep have no callback behind them, so whatever they do instead is the whole release —
// and dropping the socket from the table is three of `teardown`'s five steps, not five.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { queryHash } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub, type Topic, topic } from './channel';
import { InProcessTransport } from './fanout';
import type { Row } from './json';
import { LiveQueryRegistry } from './live-query';
import { PresenceRegistry } from './presence';
import { CLOSE, SocketRegistry } from './socket';
import { createSyncNode, type SyncNode, type SyncWs, type WsData } from './sync-node';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const BUILD_ID = 'build-1';
const ROOM: Topic = topic('org', 'o1', 'cursors');
const INPUT = { orgId: 'o1' };
const QID = queryHash('liveFeed', INPUT);
const ROWS: readonly Row[] = [{ id: 'p1', orgId: 'o1' }];

class RecordingWs implements SyncWs {
  readonly sent: Frame[] = [];
  readonly data: WsData;
  closedWith: number | null = null;

  constructor(id: string) {
    this.data = { socketId: id, clientBuildId: BUILD_ID };
  }

  /** Bytes this socket claims are queued. Over the ceiling, `SyncSocket.send` declines. */
  buffered = 0;

  send(message: string): number {
    this.sent.push(decode(message));
    return message.length;
  }

  close(code?: number): void {
    this.closedWith ??= code ?? null;
  }

  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
}

interface Harness {
  readonly node: SyncNode;
  readonly presence: PresenceRegistry;
  readonly registry: LiveQueryRegistry;
  readonly sockets: SocketRegistry;
  readonly tick: (ms: number) => void;
  connect(id: string): RecordingWs;
  /** One socket holding both kinds of state a teardown has to release: a room and a live query. */
  seat(id: string): Promise<RecordingWs>;
}

function harness(options: { idleTimeoutMs?: number } = {}): Harness {
  const clock = frozenClock(0);
  const sockets = new SocketRegistry({
    clock,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
  const transport = new InProcessTransport({ clock });
  const hub = new ChannelHub({ transport, sockets });
  hub.guard('org.>', () => true);
  const presence = new PresenceRegistry({ transport, hub, clock, ttlMs: 30_000 });
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register({
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: async () => ({ rows: ROWS, lsn: '' }),
    visible: () => true,
    matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
  });
  const node = createSyncNode({
    hub,
    registry,
    transport,
    buildId: BUILD_ID,
    sockets,
    presence,
    clock,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
  const send = async (ws: RecordingWs, frame: Frame): Promise<void> => {
    node.websocket.message(ws, encode(frame));
    await Bun.sleep(1);
  };
  return {
    node,
    presence,
    registry,
    sockets,
    tick: (ms) => clock.advance(ms),
    connect(id: string): RecordingWs {
      const ws = new RecordingWs(id);
      node.websocket.open(ws);
      return ws;
    },
    async seat(id: string): Promise<RecordingWs> {
      const ws = this.connect(id);
      await send(ws, {
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: id,
        target: { kind: 'topic', topic: ROOM },
      });
      await send(ws, {
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: `q-${id}`,
        target: { kind: 'query', qid: 'liveFeed', input: INPUT, cursor: null },
      });
      return ws;
    },
  };
}

/** Everything one socket held, asked of the node rather than of the socket table. */
async function held(app: Harness, id: string): Promise<Record<string, unknown>> {
  return {
    sockets: app.sockets.count,
    members: (await app.presence.list(ROOM)).map((member) => member.id),
    topicMembers: app.sockets.subscriberCount(ROOM),
    subscription: app.registry.subscription(id, `q-${id}`) === undefined ? 'gone' : 'held',
    subscribers: app.registry.subscriberCount(QID),
  };
}

const NOTHING = {
  sockets: 0,
  members: [],
  topicMembers: 0,
  subscription: 'gone',
  subscribers: 0,
};

describe('a socket the node evicts is released the way a closed one is', () => {
  test("Bun's close callback is the reference: it releases all five", async () => {
    const app = harness();
    const ws = await app.seat('s1');
    expect(await held(app, 's1')).toEqual({
      sockets: 1,
      members: ['s1'],
      topicMembers: 1,
      subscription: 'held',
      subscribers: 1,
    });

    app.node.websocket.close(ws);
    await Bun.sleep(1);

    expect(await held(app, 's1')).toEqual(NOTHING);
  });

  test('drain() releases them too — a rolling restart is this path, not the close callback', async () => {
    const app = harness();
    const ws = await app.seat('s1');

    await app.node.drain({ graceMs: 0 });
    await Bun.sleep(1);

    // Presence lives on the SHARED set with a 30s TTL, so a member this node never said goodbye
    // for is rendered by every other node until it expires — while the client is already back on
    // a new node under a new socket id. The live half leaks in-process: `entry.subscribers` never
    // empties, so the matcher, the shared window and the retained ring outlive the process's use
    // for them and `source.forget(qid)` is never called.
    expect(await held(app, 's1')).toEqual(NOTHING);
    expect(ws.closedWith).toBe(CLOSE.goingAway);
  });

  /**
   * The `reconnect` frame IS this socket's slot in the spread — there is no cursor behind it and
   * nothing re-sends it — so a client that never received one reconnects on its own backoff, into
   * the herd the spread exists to break. Sent fire-and-forget, a drain that reached half its
   * clients returned a plan claiming it reached all of them.
   */
  test('a reconnect frame the socket refuses is counted, not claimed as delivered', async () => {
    const app = harness();
    const reachable = await app.seat('s1');
    const drowning = await app.seat('s2');
    drowning.buffered = 4 * 1024 * 1024;

    const plan = await app.node.drain({ graceMs: 0 });

    expect(
      [...plan]
        .map((entry) => [entry.socketId, entry.notified])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ).toEqual([
      ['s1', true],
      ['s2', false],
    ]);
    expect(reachable.sent.some((frame) => frame.type === 'reconnect')).toBe(true);
    expect(drowning.sent.some((frame) => frame.type === 'reconnect')).toBe(false);
  });

  test('the idle sweep releases them too, and it has a caller at all', async () => {
    // Short enough that `start()` arms a sub-second pass; the clock the budget is measured on is
    // frozen and driven by the test, so only the interval is real.
    const app = harness({ idleTimeoutMs: 4_000 });
    const ws = await app.seat('s1');
    await app.node.start();

    app.tick(10_000);
    await Bun.sleep(1_400);

    expect(await held(app, 's1')).toEqual(NOTHING);
    expect(ws.closedWith).toBe(CLOSE.idle);
    await app.node.stop();
  }, 10_000);

  test('a socket inside its idle budget is left alone', async () => {
    const app = harness({ idleTimeoutMs: 4_000 });
    await app.seat('s1');
    await app.node.start();

    app.tick(1_000);
    await Bun.sleep(1_400);

    expect(app.sockets.count).toBe(1);
    await app.node.stop();
  }, 10_000);
});
