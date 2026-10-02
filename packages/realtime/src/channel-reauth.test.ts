// What a re-auth owes a channel seat: a denial drops it, a guard that could not decide SUSPENDS it
// (kept, and silent until a pass succeeds), and two answers are denials before any rule runs —
// nobody on a channel that decides on a row, and a row loader the tenant guard refused.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { ChannelHub, type Topic } from './channel';
import { channel } from './channel-decl';
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

/** A foreign failure: a pool that ran out while a rule or a loader reached for a row. */
class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

/** `@ultimat3/entity`'s tenant guard, as its throw arrives here: a coded error, nothing more. */
class TenantRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });

let decide: (who: Actor | null) => boolean = () => true;
let load: () => unknown = () => ({ orgId: 'o1' });
let loads = 0;
beforeEach(() => {
  decide = () => true;
  load = () => ({ orgId: 'o1' });
  loads = 0;
});
afterAll(() => {
  clearChannels();
});

const policy = {
  kind: 'allow' as const,
  label: 'test-guard',
  permissions: [],
  children: [],
  run: ({ actor: who }: { actor: Actor | null }) =>
    decide(who)
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: 'denied', code: 'X_FORBIDDEN' } as const),
};

const plain = channel('reauth-plain', {
  params: ['orgId'],
  catchUp: { name: 'orgRead' },
  events: true,
  policy,
});
channel('reauth-row', {
  params: ['orgId'],
  catchUp: { name: 'orgRead' },
  events: true,
  policy,
  row: () => {
    loads += 1;
    return load();
  },
});

const recordsOnly = channel('reauth-records', {
  params: ['orgId'],
  catchUp: { name: 'orgRead' },
  policy,
});

function rig(): { hub: ChannelHub; sockets: SocketRegistry } {
  const sockets = new SocketRegistry();
  return { hub: new ChannelHub({ transport: new InProcessTransport(), sockets }), sockets };
}

function connect(sockets: SocketRegistry, who: Actor | null): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({ ws, clientBuildId: 'b', serverBuildId: 'b', actor: who });
  sockets.add(socket);
  return { socket, ws };
}

const join = (hub: ChannelHub, socket: SyncSocket, name: 'reauth-plain' | 'reauth-row') =>
  hub.subscribeChannel(socket, { kind: 'channel', channel: name, params: { orgId: 'o1' } });

describe('a re-auth tells a denial from a guard that could not decide', () => {
  test('a denial drops the topic', async () => {
    const { hub, sockets } = rig();
    decide = (who) => who?.id === 'alice';
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-plain');

    const dropped = await hub.onActorChange(alice.socket, actor('mallory'));

    expect(dropped).toEqual([name]);
    expect(alice.socket.topics.size).toBe(0);
    expect(hub.guardFailures).toBe(0);
    expect(hub.topicCount).toBe(0);
  });

  test('a guard that RAISED is not a denial, and stops delivery until a pass succeeds', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-plain');

    decide = () => {
      throw new PoolTimeout('connection pool exhausted');
    };
    const dropped = await hub.onActorChange(alice.socket, actor('alice-again'));

    // Not a denial: a re-auth pass during an outage must not report every topic as revoked.
    expect(dropped).toEqual([]);
    expect(hub.guardFailures).toBe(1);
    // Not a pass either: nothing is delivered to an actor nobody could decide about.
    await hub.publishEvent(plain, { orgId: 'o1' }, { x: 1 });
    expect(alice.ws.frames).toHaveLength(0);
    expect(hub.topicsOf(alice.socket)).toEqual([name]);
    // The bridge is still held for it, so the pass that succeeds has something to resume.
    expect(hub.topicCount).toBe(1);
  });

  test('the next pass that succeeds delivers again', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-plain');
    decide = () => {
      throw new PoolTimeout('connection pool exhausted');
    };
    await hub.onActorChange(alice.socket, actor('alice'));
    decide = () => true;

    await expect(hub.onActorChange(alice.socket, actor('alice'))).resolves.toEqual([]);
    await hub.publishEvent(plain, { orgId: 'o1' }, { x: 1 });

    expect(alice.socket.topics.has(name)).toBe(true);
    expect(alice.ws.frames).toHaveLength(1);
    expect(hub.topicCount).toBe(1);
  });

  test("the client's beat is a pass too: it keeps the seat while broken, resumes once fixed", async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-plain');
    decide = () => {
      throw new PoolTimeout('connection pool exhausted');
    };
    await hub.onActorChange(alice.socket, actor('alice'));

    // Still broken: the beat is answered without a refusal, and the seat stays suspended.
    await expect(join(hub, alice.socket, 'reauth-plain')).resolves.toBe(name);
    expect(alice.socket.topics.has(name)).toBe(false);

    decide = () => true;
    await join(hub, alice.socket, 'reauth-plain');
    await hub.publishEvent(plain, { orgId: 'o1' }, { x: 1 });

    expect(alice.ws.frames).toHaveLength(1);
    // One seat, one reference: the beat never took a second bridge slot.
    hub.unsubscribe(alice.socket, name);
    expect(hub.topicCount).toBe(0);
  });

  test('a suspended seat that is later DENIED is dropped', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-plain');
    decide = () => {
      throw new PoolTimeout('connection pool exhausted');
    };
    await hub.onActorChange(alice.socket, actor('alice'));
    decide = () => false;

    await expect(hub.onActorChange(alice.socket, actor('alice'))).resolves.toEqual([name]);
    expect(hub.topicsOf(alice.socket)).toEqual([]);
    expect(hub.topicCount).toBe(0);
  });

  test('a socket closing while suspended gives its bridge back', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    await join(hub, alice.socket, 'reauth-plain');
    decide = () => {
      throw new PoolTimeout('connection pool exhausted');
    };
    await hub.onActorChange(alice.socket, actor('alice'));

    for (const held of hub.topicsOf(alice.socket)) hub.unsubscribe(alice.socket, held);

    expect(hub.topicCount).toBe(0);
  });
});

describe('a member who lost the org, or signed out, is DENIED — never kept as an outage', () => {
  const codes = [
    'X_TENANCY_ACTOR_ORG_REQUIRED',
    'X_TENANCY_ACTOR_MISMATCH',
    'X_TENANCY_CROSS_DENIED',
  ];

  for (const code of codes) {
    test(`a row loader refused with ${code} drops the topic`, async () => {
      const { hub, sockets } = rig();
      const alice = connect(sockets, actor('alice'));
      const name: Topic = await join(hub, alice.socket, 'reauth-row');
      load = () => {
        throw new TenantRefusal(code);
      };

      const dropped = await hub.onActorChange(alice.socket, userActor({ id: 'alice' }));

      expect(dropped).toEqual([name]);
      expect(hub.guardFailures).toBe(0);
      expect(hub.topicsOf(alice.socket)).toEqual([]);
    });
  }

  test('the same refusal at subscribe is X_TOPIC_FORBIDDEN, not a node fault', async () => {
    const { hub, sockets } = rig();
    const nobody = connect(sockets, userActor({ id: 'alice' }));
    load = () => {
      throw new TenantRefusal('X_TENANCY_ACTOR_ORG_REQUIRED');
    };

    await expect(join(hub, nobody.socket, 'reauth-row')).rejects.toBeUltimateError(
      'X_TOPIC_FORBIDDEN',
    );
  });

  test("an unscoped query is the app's defect, not a verdict: suspended, not dropped", async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    await join(hub, alice.socket, 'reauth-row');
    load = () => {
      throw new TenantRefusal('X_TENANCY_UNSCOPED');
    };

    await expect(hub.onActorChange(alice.socket, actor('alice'))).resolves.toEqual([]);
    expect(hub.guardFailures).toBe(1);
  });

  test('a signed-out socket is dropped before the loader runs', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-row');
    const before = loads;

    const dropped = await hub.onActorChange(alice.socket, null);

    expect(dropped).toEqual([name]);
    expect(loads).toBe(before);
  });

  test('nobody may not SUBSCRIBE to a channel that decides on a row either', async () => {
    const { hub, sockets } = rig();
    const nobody = connect(sockets, null);

    await expect(join(hub, nobody.socket, 'reauth-row')).rejects.toBeUltimateError(
      'X_TOPIC_FORBIDDEN',
    );
    expect(loads).toBe(0);
  });

  test('a channel with no row loader still asks its policy about nobody', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-plain');

    // `decide` allows everyone here — the public channel an anonymous socket may keep.
    await expect(hub.onActorChange(alice.socket, null)).resolves.toEqual([]);
    expect(alice.socket.topics.has(name)).toBe(true);
  });
});

describe('emit on a channel declared without events', () => {
  test('delivers nothing: its members were promised records only', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await hub.subscribeChannel(alice.socket, {
      kind: 'channel',
      channel: 'reauth-records',
      params: { orgId: 'o1' },
    });
    expect(name).toBe(recordsOnly.topic({ orgId: 'o1' }));
    const before = alice.ws.frames.length;

    await hub.emit(name, { presence: 'leave', members: [] });

    expect(alice.ws.frames).toHaveLength(before);
  });

  test('an events channel still delivers', async () => {
    const { hub, sockets } = rig();
    const alice = connect(sockets, actor('alice'));
    const name = await join(hub, alice.socket, 'reauth-plain');

    await hub.emit(name, { x: 1 });

    expect(alice.ws.frames).toHaveLength(1);
  });
});
