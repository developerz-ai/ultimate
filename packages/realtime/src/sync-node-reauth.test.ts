// What the node owes a socket whose grant was re-decided, a bus that reconnected, and a socket that
// closed: a dropped subscription is SAID under its sid, one re-auth pass runs at a time, a
// reconnect invalidates every window, and a close leaves only the rooms that have a roster.

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import { InProcessTransport, type Transport } from './fanout';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { PresenceRegistry } from './presence';
import { SocketRegistry } from './socket';
import type { SyncGrant } from './sync-auth';
import { createSyncNode, type SyncNode, type SyncWs, type WsData } from './sync-node';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });
const removed: Actor = userActor({ id: 'alice', orgId: 'o2' });

const ownOrg = {
  kind: 'allow' as const,
  label: 'own-org',
  permissions: [],
  children: [],
  run: ({ actor, input }: { actor: Actor | null; input: unknown }) =>
    actor?.orgId === (input as { orgId?: string }).orgId
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: 'another tenant', code: 'X_FORBIDDEN' } as const),
};
channel('reauth-feed', { params: ['orgId'], catchUp: { name: 'feedRead' }, policy: ownOrg });
channel('reauth-room', {
  params: ['orgId'],
  catchUp: { name: 'roomRead' },
  policy: ownOrg,
  events: true,
});
afterAll(() => {
  clearChannels();
});

/** A denial as a real policy raises it: a coded throw, read by its code. */
class Denied extends Error {
  readonly code = 'X_FORBIDDEN';
  override readonly cause = 'feed:read denied';
  readonly fix = 'x policy list --json';
}

const orgFeed: LiveQueryDefinition = {
  name: 'orgFeed',
  entities: ['posts'],
  snapshot: async () => ({ rows: [{ id: 'p1', orgId: 'o1' }], lsn: '' }),
  authorize: ({ actor }) => {
    if (actor?.orgId !== 'o1') throw new Denied('denied');
  },
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
};

class RecordingWs {
  readonly sent: Frame[] = [];
  data!: WsData;
  send(raw: string): number {
    this.sent.push(decode(raw));
    return raw.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

interface Rig {
  readonly node: SyncNode;
  readonly registry: LiveQueryRegistry;
  readonly hub: ChannelHub;
  readonly transport: Transport;
  readonly presence: PresenceRegistry;
  readonly clock: ReturnType<typeof frozenClock>;
  dial(): Promise<RecordingWs>;
  send(ws: RecordingWs, frame: Frame): Promise<void>;
}

function rig(
  authenticate: () => Promise<SyncGrant | null>,
  transport: Transport = new InProcessTransport(),
): Rig {
  const clock = frozenClock(0);
  const sockets = new SocketRegistry({ clock });
  const hub = new ChannelHub({ transport, sockets });
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(orgFeed);
  const presence = new PresenceRegistry({ transport, hub, clock });
  const node = createSyncNode({
    hub,
    registry,
    transport,
    buildId: 'b',
    sockets,
    presence,
    clock,
    authenticate,
    reauthenticateIntervalMs: 1,
  });
  return {
    node,
    registry,
    hub,
    transport,
    presence,
    clock,
    async dial(): Promise<RecordingWs> {
      const ws = new RecordingWs();
      await node.fetch(new Request('http://node/_x/sync'), {
        upgrade(_request, options) {
          ws.data = options.data;
          node.websocket.open(ws as unknown as SyncWs);
          return true;
        },
        requestIP: () => null,
      });
      return ws;
    },
    async send(ws, frame): Promise<void> {
      node.websocket.message(ws as unknown as SyncWs, encode(frame));
      await Bun.sleep(2);
    },
  };
}

const subscribe = (
  sid: string,
  target: Extract<Frame, { type: 'subscribe' }>['target'],
): Frame => ({
  type: 'subscribe',
  v: PROTOCOL_VERSION,
  op: 'add',
  sid,
  target,
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  expect.unreachable('the node never got there');
}

const acks = (ws: RecordingWs): Extract<Frame, { type: 'ack' }>[] =>
  ws.sent.filter((frame): frame is Extract<Frame, { type: 'ack' }> => frame.type === 'ack');

describe('a re-auth that drops a subscription says so under its sid', () => {
  test('a live query and a channel the new actor may not read are both refused', async () => {
    let next: Actor = alice;
    const grant = (): SyncGrant => ({
      actor: next,
      expiresAt: 1_000,
      refresh: async () => ({ actor: next, expiresAt: Number.MAX_SAFE_INTEGER }),
    });
    const app = rig(async () => grant());
    await app.node.start();
    const ws = await app.dial();
    await app.send(
      ws,
      subscribe('q-1', { kind: 'query', qid: 'orgFeed', input: {}, cursor: null }),
    );
    await app.send(
      ws,
      subscribe('c-1', { kind: 'channel', channel: 'reauth-feed', params: { orgId: 'o1' } }),
    );
    expect(acks(ws)).toEqual([]);

    // The member is moved out of the org; the grant's window closes; the sweep re-decides.
    next = removed;
    app.clock.advance(2_000);
    await until(() => acks(ws).length === 2);

    const refused = new Map(acks(ws).map((ack) => [ack.ref, ack.error?.code]));
    expect(refused.get('q-1')).toBe('X_FORBIDDEN');
    expect(refused.get('c-1')).toBe('X_TOPIC_FORBIDDEN');
    expect(app.registry.subscription(ws.data.socketId, 'q-1')).toBeUndefined();
    expect(app.node.sockets.get(ws.data.socketId)?.topics.size).toBe(0);
    await app.node.stop();
  });
});

describe('the re-auth pass', () => {
  test('is one at a time: a pass that outlasts the interval is not started again', async () => {
    let refreshes = 0;
    let release!: () => void;
    const parked = new Promise<void>((settle) => {
      release = settle;
    });
    const app = rig(async () => ({
      actor: alice,
      expiresAt: 1_000,
      refresh: async () => {
        refreshes += 1;
        await parked;
        return { actor: alice, expiresAt: Number.MAX_SAFE_INTEGER };
      },
    }));
    await app.node.start();
    await app.dial();
    app.clock.advance(2_000);

    // Many 1 ms ticks land while the first pass is parked in the token service.
    await Bun.sleep(25);
    expect(refreshes).toBe(1);

    release();
    await app.node.stop();
  });
});

describe('a bus that reconnected', () => {
  test('invalidates every window on the node, without waiting for the next change', async () => {
    const listeners: (() => void)[] = [];
    const inner = new InProcessTransport();
    const transport = Object.assign(inner, {
      onReconnect(listener: () => void): () => void {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
    });
    const app = rig(async () => ({ actor: alice }), transport);
    await app.node.start();
    const ws = await app.dial();
    await app.send(
      ws,
      subscribe('q-1', { kind: 'query', qid: 'orgFeed', input: {}, cursor: null }),
    );
    const socket = app.node.sockets.get(ws.data.socketId);
    expect(socket?.desynced.has('q-1')).toBe(false);

    const channels = spyOn(app.hub, 'invalidate');
    for (const listener of listeners) listener();

    expect(socket?.desynced.has('q-1')).toBe(true);
    // Channel rings too: their seq is minted from what this node saw.
    expect(channels).toHaveBeenCalledTimes(1);
    await app.node.stop();
    // And the node lets go of the hook with everything else it acquired.
    expect(listeners).toEqual([]);
  });
});

describe('a socket that closes', () => {
  test('leaves the rooms that have a roster, and no channel that never had one', async () => {
    const app = rig(async () => ({ actor: alice }));
    await app.node.start();
    const ws = await app.dial();
    await app.send(
      ws,
      subscribe('c-1', { kind: 'channel', channel: 'reauth-feed', params: { orgId: 'o1' } }),
    );
    await app.send(
      ws,
      subscribe('c-2', { kind: 'channel', channel: 'reauth-room', params: { orgId: 'o1' } }),
    );
    const leave = spyOn(app.presence, 'leave');

    app.node.websocket.close(ws as unknown as SyncWs);
    await Bun.sleep(2);

    expect(leave.mock.calls.map(([name]) => String(name))).toEqual(['reauth-room.o1']);
    await app.node.stop();
  });
});

describe('a change sequence that skipped', () => {
  test('invalidates the channel rings beside the live windows', async () => {
    const app = rig(async () => ({ actor: alice }));
    await app.node.start();
    const windows = spyOn(app.registry, 'invalidate');
    const channels = spyOn(app.hub, 'invalidate');
    const publish = async (seq: number): Promise<void> => {
      await app.transport.publish(
        'x.change.posts.o1',
        JSON.stringify({
          entity: 'posts',
          op: 'insert',
          before: null,
          after: { id: `p${seq}`, orgId: 'o1' },
          lsn: String(seq).padStart(16, '0'),
          txid: String(seq),
          orgId: 'o1',
          at: 0,
          producer: 'run-1',
          seq,
        }),
      );
      await Bun.sleep(1);
    };

    await publish(1);
    await publish(2);
    expect(channels).toHaveBeenCalledTimes(0);
    // seq 3 never arrives.
    await publish(4);

    expect(windows).toHaveBeenCalledTimes(1);
    expect(channels).toHaveBeenCalledTimes(1);
    await app.node.stop();
  });
});
