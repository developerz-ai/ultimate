// What one socket may cost this node. The accept budget spends a token per UPGRADE and nothing
// else was bounded after that: an authenticated socket could drive unlimited frames into a DB
// read and a fleet-wide publish, and unlimited sockets could be held open at 500/s.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { createFrameRouter } from './sync-frames';
import {
  createSyncNode,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_FRAME_BYTES,
  type SyncNode,
  type UpgradeTarget,
  type WsData,
} from './sync-node';
import { decode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const BUILD_ID = 'build-1';
const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  data!: WsData;
  /** What a browser reports as queued-but-unwritten. Set by a test to back this socket up. */
  buffered = 0;
  send(raw: string): number {
    this.frames.push(decode(raw));
    return raw.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
}

/** Counts the reads a subscribe frame reaches — the amplifier the budget exists to keep shut. */
let reads = 0;
const feed: LiveQueryDefinition = {
  name: 'feed',
  entities: ['posts'],
  async snapshot() {
    reads += 1;
    return { rows: [], lsn: '' };
  },
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
};

function harness(options: { maxFramesPerSecond?: number; frameBurst?: number } = {}): {
  socket: SyncSocket;
  ws: FakeWs;
  route: (frame: Frame) => Promise<void>;
} {
  const clock = frozenClock(0);
  const transport = new InProcessTransport();
  const sockets = new SocketRegistry({ clock });
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer(), clock });
  registry.register(feed);
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: BUILD_ID,
    serverBuildId: BUILD_ID,
    actor: alice,
    clock,
    ...options,
  });
  sockets.add(socket);
  const route = createFrameRouter({
    hub: new ChannelHub({ transport, sockets }),
    registry,
    buildId: BUILD_ID,
  });
  return { socket, ws, route: (frame) => route(socket, frame) };
}

function subscribe(sid: string): Frame {
  return {
    type: 'subscribe',
    v: PROTOCOL_VERSION,
    op: 'add',
    sid,
    target: { kind: 'query', qid: 'feed', input: { page: sid }, cursor: null },
  };
}

function upgradeTarget(): UpgradeTarget {
  return { upgrade: () => true };
}

function node(
  options: { maxConnections?: number; maxBufferedBytes?: number; maxDroppedFrames?: number } = {},
): {
  sync: SyncNode;
  sockets: SocketRegistry;
} {
  const transport = new InProcessTransport();
  const sockets = new SocketRegistry();
  const sync = createSyncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: BUILD_ID,
    sockets,
    ...options,
  });
  return { sync, sockets };
}

describe('the per-socket frame budget', () => {
  test('refuses the frame past the burst and never reaches the read behind it', async () => {
    reads = 0;
    const { route, socket } = harness({ maxFramesPerSecond: 5, frameBurst: 5 });
    for (let i = 0; i < 5; i += 1) await route(subscribe(`s${i}`));
    expect(reads).toBe(5);

    // The clock is frozen, so the bucket never refills: frame 6 is the one over the budget.
    await expect(route(subscribe('s5'))).rejects.toMatchObject({
      code: 'X_FRAME_RATE_LIMIT',
    });
    // Not one byte of the amplifier ran — no read, no subscription, no presence write.
    expect(reads).toBe(5);
    expect(socket.queries.size).toBe(5);
  });

  test('a refused frame does not touch the socket, so a flood cannot hold it open', async () => {
    const { route, socket } = harness({ maxFramesPerSecond: 1, frameBurst: 1 });
    await route({
      type: 'hello',
      v: PROTOCOL_VERSION,
      buildId: BUILD_ID,
      sessionId: null,
      actorId: null,
    });
    const touchedAt = socket.lastSeenAt;
    await expect(
      route({
        type: 'hello',
        v: PROTOCOL_VERSION,
        buildId: BUILD_ID,
        sessionId: null,
        actorId: null,
      }),
    ).rejects.toMatchObject({ code: 'X_FRAME_RATE_LIMIT' });
    expect(socket.lastSeenAt).toBe(touchedAt);
  });

  test('the default burst admits a client subscribing its whole per-socket cap at once', () => {
    const { socket } = harness();
    expect(socket.frameBudget.tokens).toBeGreaterThanOrEqual(128);
  });
});

describe('the connection ceiling', () => {
  test('answers 503 with a retry-after-ms once the node is full', async () => {
    const { sync, sockets } = node({ maxConnections: 2 });
    await sync.start();
    for (const id of ['a', 'b']) {
      sockets.add(
        new SyncSocket({
          ws: new FakeWs(),
          id,
          clientBuildId: BUILD_ID,
          serverBuildId: BUILD_ID,
        }),
      );
    }
    const response = await sync.fetch(new Request('http://node.test/_x/sync'), upgradeTarget());
    expect(response?.status).toBe(503);
    expect(Number(response?.headers.get('retry-after-ms'))).toBeGreaterThan(0);
    await sync.stop();
  });

  test('admits the upgrade while there is room', async () => {
    const { sync } = node({ maxConnections: 2 });
    await sync.start();
    const response = await sync.fetch(new Request('http://node.test/_x/sync'), upgradeTarget());
    expect(response).toBeUndefined();
    await sync.stop();
  });

  test('the default ceiling clears the benchmarked 50,000 sockets', () => {
    expect(DEFAULT_MAX_CONNECTIONS).toBeGreaterThanOrEqual(50_000);
  });
});

/**
 * The two ceilings that decide when a socket starts losing frames and when it is closed for it.
 * They were `SyncSocketOptions` only, and `sync-node` constructs every socket itself — so an
 * operator whose clients are slower than this node's fanout could not move either without
 * abandoning `createSyncNode` and building the socket by hand.
 */
describe('the backpressure ceilings', () => {
  const open = (
    sync: SyncNode,
    sockets: SocketRegistry,
    buffered: number,
  ): SyncSocket | undefined => {
    const ws = new FakeWs();
    ws.buffered = buffered;
    ws.data = { socketId: 'sock-1', clientBuildId: BUILD_ID };
    sync.websocket.open(ws);
    return sockets.get('sock-1');
  };
  const frame: Frame = { type: 'update-available', v: PROTOCOL_VERSION, buildId: BUILD_ID };

  test('are reachable from createSyncNode, so the drop point is an operator decision', () => {
    const { sync, sockets } = node({ maxBufferedBytes: 8, maxDroppedFrames: 0 });

    const socket = open(sync, sockets, 9);

    // Over the buffer this node was configured with: the frame is dropped, and the first drop is
    // already past a `maxDroppedFrames` of 0, so the socket goes with it.
    expect(socket?.send(frame)).toBe(false);
    expect(socket?.droppedFrames).toBe(1);
    expect(socket?.closed).toBe(true);
  });

  test('and both keep their defaults when the node names neither', () => {
    const { sync, sockets } = node();

    const socket = open(sync, sockets, 9);

    expect(socket?.send(frame)).toBe(true);
    expect(socket?.closed).toBe(false);
  });
});

describe('the inbound frame size cap', () => {
  test('is declared on the websocket handler, so every host that mounts it inherits one', () => {
    const { sync } = node();
    expect(sync.websocket.maxPayloadLength).toBe(DEFAULT_MAX_FRAME_BYTES);
    expect(DEFAULT_MAX_FRAME_BYTES).toBeLessThan(16 * 1024 * 1024);
  });
});

// Bun's `backpressureLimit` and `SyncSocket`'s own check on `getBufferedAmount` are two ends of one
// socket's one buffer. Asserted through behaviour, not by comparing the two constants: they are one
// declaration now, so an equality between them is a test that cannot fail.
describe('the outbound buffer ceiling', () => {
  const frame: Frame = { type: 'update-available', v: PROTOCOL_VERSION, buildId: BUILD_ID };
  const socketAt = (buffered: number): SyncSocket | undefined => {
    const { sync, sockets } = node();
    const ws = new FakeWs();
    ws.data = { socketId: 'sock-1', clientBuildId: BUILD_ID };
    ws.buffered = buffered;
    sync.websocket.open(ws);
    return sockets.get('sock-1');
  };

  test('refuses a frame the runtime would have dropped, so the subscriber is marked', () => {
    const { sync } = node();
    // One byte past Bun's limit. If our own ceiling were the higher of the two, the runtime would
    // discard this frame with nothing desynced — the silent divergence the mark exists to prevent.
    const socket = socketAt(sync.websocket.backpressureLimit + 1);

    expect(socket?.send(frame)).toBe(false);
    expect(socket?.droppedFrames).toBe(1);
  });

  test('and still writes below it, so our check is not the tighter of the two either', () => {
    const { sync } = node();
    // A socket the runtime would happily write must not be one this node has already given up on.
    const socket = socketAt(sync.websocket.backpressureLimit - 1);

    expect(socket?.send(frame)).toBe(true);
    expect(socket?.droppedFrames).toBe(0);
  });
});
