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
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { CLOSE, SocketRegistry, type WsLike } from './socket';
import type { SyncGrant } from './sync-auth';
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
  /** Every close the CLIENT would have seen, in order — the first one is the only one it gets. */
  readonly closes: (readonly [number, string])[] = [];
  data!: WsData;
  send(raw: string): number {
    this.frames.push(decode(raw));
    return raw.length;
  }
  close(code = 0, reason = ''): void {
    this.closes.push([code, reason]);
  }
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

/**
 * Accepts every upgrade, remembers the data the node attached — and OPENS THE SOCKET INSIDE
 * `upgrade()`, synchronously, before returning, which is what Bun does (measured on bun 1.3.14).
 *
 * This stub returned `true` and left `open` to the test, several statements later, so the node
 * could record a socket's grant after the upgrade and still look right here: by the time a test
 * called `node.websocket.open(...)` by hand, the book it reads was full. Under Bun it is empty,
 * and every authenticated socket carried `actor: null`. A harness that is easier on the code than
 * the runtime is a regression test that cannot fail.
 */
function upgradeTarget(node: SyncNode): UpgradeTarget & { data: WsData | null; ws: FakeWs | null } {
  return {
    data: null,
    ws: null,
    upgrade(_request: Request, options: { data: WsData }): boolean {
      this.data = options.data;
      const ws = new FakeWs();
      ws.data = options.data;
      this.ws = ws;
      node.websocket.open(ws as unknown as SyncWs);
      return true;
    },
  };
}

function nodeWith(
  authenticate?: (request: Request) => Promise<SyncGrant | null>,
  extra: { reauthenticateIntervalMs?: number } = {},
): {
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
    ...extra,
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
    const server = upgradeTarget(node);

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
    const server = upgradeTarget(node);

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
    const server = upgradeTarget(node);

    expect(await node.fetch(upgradeRequest, server)).toBeUndefined();
    const data = server.data;
    const ws = server.ws;
    if (!data || !ws) throw new Error('the upgrade was refused');

    // Read with no `open` call of its own: the socket already exists, because `upgrade()` opened
    // it. Which is the whole failure — the grant has to be in the book by then, not after.
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
    const server = upgradeTarget(node);
    await node.fetch(upgradeRequest, server);
    const data = server.data;
    if (!data) throw new Error('the upgrade was refused');
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

  test('a node that stopped accepting mid-authentication sheds rather than upgrades', async () => {
    let release!: () => void;
    const authenticating = new Promise<void>((settle) => {
      release = settle;
    });
    const { node, sockets } = nodeWith(async () => {
      await authenticating;
      return { actor: alice };
    });
    await node.start();
    const server = upgradeTarget(node);

    // Past the readiness check at the top of `fetch` and parked in the app's token service.
    const upgrading = node.fetch(upgradeRequest, server);
    await Promise.resolve();
    // SIGTERM lands. The `accept` phase is over before this request reaches `server.upgrade`.
    node.stopAccepting();
    release();
    const response = await upgrading;

    // A draining node that upgrades one more socket is the whole point of the accept phase, gone:
    // the load balancer has already been told this node is out, so nothing will replace it.
    expect(response?.status).toBe(503);
    expect(response?.headers.get('retry-after-ms')).not.toBeNull();
    expect(server.data).toBeNull();
    expect(sockets.count).toBe(0);
    await node.stop();
  });

  test('with no authenticator the node still accepts, and every socket is anonymous', async () => {
    const { node, sockets } = nodeWith();
    await node.start();
    const server = upgradeTarget(node);

    expect(await node.fetch(upgradeRequest, server)).toBeUndefined();
    const data = server.data;
    if (!data) throw new Error('the upgrade was refused');

    expect(sockets.get(data.socketId)?.actor).toBeNull();
    await node.stop();
  });
});

/**
 * A grant with no way to renew it is the one eviction path that did not go through `evict`. It ran
 * `teardown(socket)` and *then* `socket.close(1008)` — but `teardown` reaches
 * `SocketRegistry.remove`, which closes the socket itself with `1001 connection closed`, and
 * `SyncSocket.close` returns early once it is closed. So the client was told `goingAway`: a normal
 * shutdown, which a client retries against the same node with the same dead credential, instead of
 * `1008 policy` — the code `packages/realtime/CLAUDE.md` documents for "no refresh = close with
 * 1008 and let the client re-dial".
 */
describe('a grant the node cannot renew', () => {
  test('closes the client with 1008, not the goingAway the socket table hands it', async () => {
    const { node, sockets } = nodeWith(async () => ({ actor: alice, expiresAt: 0 }), {
      reauthenticateIntervalMs: 1,
    });
    await node.start();
    const server = upgradeTarget(node);
    await node.fetch(upgradeRequest, server);
    const data = server.data;
    const ws = server.ws;
    if (!data || !ws) throw new Error('the upgrade was refused');
    expect(sockets.get(data.socketId)).toBeDefined();

    await until(() => ws.closes.length > 0);

    expect(ws.closes).toEqual([[CLOSE.policy, 'grant expired']]);
    // And the release still happened: the socket is out of the table, not merely closed.
    expect(sockets.get(data.socketId)).toBeUndefined();
    await node.stop();
  });
});
