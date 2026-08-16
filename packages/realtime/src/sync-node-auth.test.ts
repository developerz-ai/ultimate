// The node's authentication seam, driven without a server: `fetch` decides, `open` carries what it
// decided, and every policy downstream is asked about that actor rather than about `null`.
//
// Failure case first — until this file existed, `WsData.actorId` was the literal `null` and no
// header, cookie or query token was read anywhere, so `visible({ actor })` was structurally
// incapable of seeing a caller.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub, topic } from './channel';
import { InProcessTransport } from './fanout';
import type { Row } from './json';
import { type LiveQueryDefinition, LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SocketRegistry, type WsLike } from './socket';
import {
  createSyncNode,
  type SyncNode,
  type SyncWs,
  type UpgradeTarget,
  type WsData,
} from './sync-node';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const BUILD_ID = 'build-1';
const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  data!: WsData;
  send(raw: string): number {
    this.frames.push(decode(raw));
    return raw.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

/** Records who `visible` was asked about — the whole question this file answers. */
const seenBy: (Actor | null)[] = [];

const rows: Row[] = [{ id: 'p1', orgId: 'o1', ownerId: 'alice' }];

const ownFeed: LiveQueryDefinition = {
  name: 'ownFeed',
  entities: ['posts'],
  async snapshot() {
    return { rows, lsn: '' };
  },
  visible({ actor, row }) {
    seenBy.push(actor);
    return row['ownerId'] === actor?.id;
  },
  matcher() {
    return {
      entities: ['posts'],
      match: (change) => {
        const patch = patchFromChange(change);
        return { patches: patch ? [patch] : [], refill: false };
      },
    };
  },
};

/** Accepts every upgrade and remembers the data the node attached. */
function upgradeTarget(): UpgradeTarget & { data: WsData | null } {
  return {
    data: null,
    upgrade(_request: Request, options: { data: WsData }): boolean {
      this.data = options.data;
      return true;
    },
  };
}

function nodeWith(authenticate?: (request: Request) => Promise<null | { actor: Actor }>): {
  node: SyncNode;
  sockets: SocketRegistry;
  hub: ChannelHub;
} {
  const sockets = new SocketRegistry();
  const transport = new InProcessTransport();
  const hub = new ChannelHub({ transport, sockets });
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
  registry.register(ownFeed);
  const node = createSyncNode({
    hub,
    registry,
    transport,
    buildId: BUILD_ID,
    sockets,
    clock: frozenClock(0),
    ...(authenticate ? { authenticate } : {}),
  });
  return { node, sockets, hub };
}

const upgradeRequest = new Request('http://node/_x/sync');

/**
 * The WS message handler is fire-and-forget by design — a frame's work must not block the socket —
 * so a test waits for the answer rather than for a fixed number of ticks.
 */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('the node never answered');
}

describe('the sync node authenticates an upgrade', () => {
  test('a refused credential never becomes a websocket, and says so as a wire error', async () => {
    const { node } = nodeWith(async () => null);
    await node.start();
    const server = upgradeTarget();

    const response = await node.fetch(upgradeRequest, server);

    expect(response?.status).toBe(401);
    expect(server.data).toBeNull();
    const body = (await response?.json()) as { error: { code: string; fix: string } };
    expect(body.error.code).toBe('X_SOCKET_UNAUTHENTICATED');
    expect(body.error.fix).toContain('createSyncNode');
    await node.stop();
  });

  /** A failure is not a denial: the client is told to come back, not told it may not connect. */
  test('an authenticator that raises answers 503, not 401', async () => {
    const { node } = nodeWith(async () => {
      throw new Error('token service unreachable');
    });
    await node.start();
    const server = upgradeTarget();

    const response = await node.fetch(upgradeRequest, server);

    expect(response?.status).toBe(503);
    expect(server.data).toBeNull();
    const body = (await response?.json()) as { error: { code: string } };
    expect(body.error.code).toBe('X_SOCKET_AUTH_UNAVAILABLE');
    await node.stop();
  });

  test('an accepted credential rides into the socket and into the row policy', async () => {
    seenBy.length = 0;
    const { node, sockets } = nodeWith(async () => ({ actor: alice }));
    await node.start();
    const server = upgradeTarget();

    expect(await node.fetch(upgradeRequest, server)).toBeUndefined();
    const data = server.data;
    if (!data) throw new Error('the upgrade was refused');

    const ws = new FakeWs();
    ws.data = data;
    node.websocket.open(ws as unknown as SyncWs);

    expect(sockets.get(data.socketId)?.actor).toBe(alice);
    expect(sockets.get(data.socketId)?.actorId).toBe('alice');

    // Subscribing is the proof that matters: the row gate is handed this actor, not `null`.
    node.websocket.message(
      ws as unknown as SyncWs,
      encode({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: 'sid-1',
        target: { kind: 'query', qid: 'ownFeed', input: { orgId: 'o1' }, cursor: null },
      }),
    );
    await until(() => ws.frames.some((frame) => frame.type === 'snapshot'));

    expect(seenBy).toEqual([alice]);
    const snapshot = ws.frames.find((frame) => frame.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' && snapshot.rows.map((row) => row.id)).toEqual(['p1']);
    await node.stop();
  });

  test('a topic guard reading the actor can finally deny one caller and admit another', async () => {
    const { node, sockets, hub } = nodeWith(async () => ({ actor: alice }));
    hub.guard('org.*.feed', ({ actor, segments }) => actor?.orgId === segments[1]);
    await node.start();
    const server = upgradeTarget();
    await node.fetch(upgradeRequest, server);
    const data = server.data;
    if (!data) throw new Error('the upgrade was refused');
    const ws = new FakeWs();
    ws.data = data;
    node.websocket.open(ws as unknown as SyncWs);
    const socket = sockets.get(data.socketId);
    if (!socket) throw new Error('the socket was never registered');

    await hub.subscribe(socket, topic('org', 'o1', 'feed'));
    expect(socket.topics.has('org.o1.feed')).toBe(true);
    // The same guard, the same socket, another tenant's room.
    await expect(hub.subscribe(socket, topic('org', 'o2', 'feed'))).rejects.toBeUltimateError(
      'X_TOPIC_FORBIDDEN',
    );
    await node.stop();
  });

  test('with no authenticator the node still accepts, and every socket is anonymous', async () => {
    const { node, sockets } = nodeWith();
    await node.start();
    const server = upgradeTarget();

    expect(await node.fetch(upgradeRequest, server)).toBeUndefined();
    const data = server.data;
    if (!data) throw new Error('the upgrade was refused');
    const ws = new FakeWs();
    ws.data = data;
    node.websocket.open(ws as unknown as SyncWs);

    expect(sockets.get(data.socketId)?.actor).toBeNull();
    await node.stop();
  });
});
