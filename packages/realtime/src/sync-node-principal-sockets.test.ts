// One principal's sockets on a node, capped at the upgrade. The per-actor subscription cap bounds
// what one principal HOLDS; without a socket cap it could still open sockets until the node's
// `maxConnections`, each a grant, a frame budget and a heartbeat. Keyed exactly like the
// subscription principal: the actor, else the anonymous caller's network (IPv4, IPv6 /64).

import { describe, expect, test } from 'bun:test';
import { type Actor, anonymousActor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { ANONYMOUS_SOCKET_MULTIPLIER, DEFAULT_MAX_SOCKETS_PER_ACTOR } from './principal-sockets';
import { SocketRegistry, type WsLike } from './socket';
import type { SyncGrant } from './sync-auth';
import { type SyncNode, type SyncWs, syncNode, type WsData } from './sync-node';

class FakeWs implements WsLike {
  data!: WsData;
  send(raw: string): number {
    return raw.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

interface Dial {
  readonly status: number | null;
  readonly code: string | null;
  readonly fix: string | null;
  readonly ws: FakeWs | null;
}

const build = (
  extra: { maxSocketsPerActor?: number; open?: 'ok' | 'throw' | 'decline' } = {},
): { node: SyncNode; dial: (actor: Actor | null, address: string) => Promise<Dial> } => {
  const sockets = new SocketRegistry();
  const transport = new InProcessTransport();
  const node = syncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: 'b',
    sockets,
    clock: frozenClock(0),
    // The grant names the actor the dial carries in a header — one node, many principals.
    authenticate: async (request): Promise<SyncGrant | null> => {
      const id = request.headers.get('x-actor');
      return { actor: id === null ? anonymousActor() : userActor({ id }) };
    },
    ...(extra.maxSocketsPerActor === undefined
      ? {}
      : { maxSocketsPerActor: extra.maxSocketsPerActor }),
  });
  const dial = async (actor: Actor | null, address: string): Promise<Dial> => {
    let opened: FakeWs | null = null;
    const response = await node
      .fetch(
        new Request('http://node/_x/sync', {
          headers: actor === null ? {} : { 'x-actor': actor.id },
        }),
        {
          upgrade(_request: Request, options: { data: WsData }): boolean {
            if (extra.open === 'throw') throw new TypeError('open blew up');
            if (extra.open === 'decline') return false;
            const ws = new FakeWs();
            ws.data = options.data;
            node.websocket.open(ws as unknown as SyncWs);
            opened = ws;
            return true;
          },
          requestIP: () => ({ address }),
        },
      )
      .catch(() => undefined);
    if (response === undefined) return { status: null, code: null, fix: null, ws: opened };
    const body = (await response.json().catch(() => null)) as {
      error?: { code: string; fix: string };
    } | null;
    return {
      status: response.status,
      code: body?.error?.code ?? null,
      fix: body?.error?.fix ?? null,
      ws: opened,
    };
  };
  return { node, dial };
};

describe('the per-principal socket cap at the upgrade', () => {
  test('the N+1th socket of one actor is 429 X_SOCKET_LIMIT while another actor connects', async () => {
    const { node, dial } = build({ maxSocketsPerActor: 2 });
    await node.start();
    const mallory = userActor({ id: 'mallory' });
    expect((await dial(mallory, '198.51.100.1')).status).toBeNull();
    expect((await dial(mallory, '198.51.100.2')).status).toBeNull();
    const third = await dial(mallory, '198.51.100.3');
    expect(third.status).toBe(429);
    expect(third.code).toBe('X_SOCKET_LIMIT');
    expect(third.fix).toContain('defineConfig({ realtime: { maxSocketsPerActor');
    expect(third.fix).toContain('maxSocketsPerActor on syncNode');
    expect((await dial(userActor({ id: 'alice' }), '198.51.100.1')).status).toBeNull();
    await node.stop();
  });

  test('closing a socket frees its slot', async () => {
    const { node, dial } = build({ maxSocketsPerActor: 1 });
    await node.start();
    const u = userActor({ id: 'u' });
    const first = await dial(u, '198.51.100.1');
    expect((await dial(u, '198.51.100.1')).status).toBe(429);
    node.websocket.close(first.ws as unknown as SyncWs);
    expect((await dial(u, '198.51.100.1')).status).toBeNull();
    await node.stop();
  });

  test('two anonymous addresses in one IPv6 /64 share the cap; another /64 does not', async () => {
    const { node, dial } = build({ maxSocketsPerActor: 1 });
    await node.start();
    // A network's cap is 8 x the actor cap of 1: eight addresses of one /64 fill it.
    for (let host = 1; host <= ANONYMOUS_SOCKET_MULTIPLIER; host += 1) {
      expect((await dial(null, `2001:db8:aa:bb::${host.toString(16)}`)).status).toBeNull();
    }
    expect((await dial(null, '2001:db8:aa:bb::ffff')).status).toBe(429);
    expect((await dial(null, '2001:db8:aa:bc::1')).status).toBeNull();
    await node.stop();
  });

  test.each(['throw', 'decline'] as const)(
    'an upgrade that fails after the slot was taken (%s) gives the slot back',
    async (open) => {
      const failing = build({ maxSocketsPerActor: 1, open });
      await failing.node.start();
      const u = userActor({ id: 'u' });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await failing.dial(u, '198.51.100.1')).code).not.toBe('X_SOCKET_LIMIT');
      }
      expect(failing.node.principalSockets('actor:u')).toBe(0);
      await failing.node.stop();
    },
  );

  // One office behind one NAT viewing a PUBLIC live page is one anonymous network: held to an
  // actor's 16 it was 16 sockets for the whole floor. A network gets 8 x the actor cap.
  test('an anonymous network admits 8 x the actor cap; an actor stops at the actor cap', async () => {
    const { node, dial } = build({ maxSocketsPerActor: 2 });
    await node.start();
    const network = 2 * ANONYMOUS_SOCKET_MULTIPLIER;
    for (let i = 0; i < network; i += 1) {
      expect((await dial(null, '198.51.100.7')).status).toBeNull();
    }
    const over = await dial(null, '198.51.100.7');
    expect(over.status).toBe(429);
    expect(over.code).toBe('X_SOCKET_LIMIT');
    const u = userActor({ id: 'office-worker' });
    expect((await dial(u, '198.51.100.7')).status).toBeNull();
    expect((await dial(u, '198.51.100.7')).status).toBeNull();
    expect((await dial(u, '198.51.100.7')).status).toBe(429);
    await node.stop();
  });

  test('with the defaults: 128 anonymous sockets from one network, the 129th refused', async () => {
    const { node, dial } = build();
    await node.start();
    for (let i = 0; i < 128; i += 1) expect((await dial(null, '203.0.113.5')).status).toBeNull();
    expect((await dial(null, '203.0.113.5')).status).toBe(429);
    expect(ANONYMOUS_SOCKET_MULTIPLIER * DEFAULT_MAX_SOCKETS_PER_ACTOR).toBe(128);
    await node.stop();
  });

  test('the default is 16 — 16 sockets of 128 subscriptions reach the 1,000 actor cap', () => {
    expect(DEFAULT_MAX_SOCKETS_PER_ACTOR).toBe(16);
  });

  test.each([0, -1, 1.5, Number.NaN])('maxSocketsPerActor %p is refused at construction', (max) => {
    let code = 'accepted';
    try {
      build({ maxSocketsPerActor: max });
    } catch (error) {
      code = (error as { readonly code?: string }).code ?? 'uncoded';
    }
    expect(code).toBe('X_CONFIG_INVALID');
  });
});
