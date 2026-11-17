// A records channel keyed by its entity's tenant column is joined only by that tenant's members,
// whatever the policy says. The policy here is the leaking shape — `post:read` with no org
// comparison — so every refusal below is the mechanism's, not the rule's.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { QueryPolicy } from '@ultimat3/query';
import type { ChangeEvent } from './changefeed';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { presenceEvent } from './channel-presence';
import { clearChannels } from './channel-registry';
import { TopicForbiddenError } from './errors';
import { InProcessTransport } from './fanout';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

const posts = entity('channel_tenant_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text() },
});

afterAll(() => {
  clearRegistry();
  clearChannels();
});

/** `can('post:read')` with no org comparison: any signed-in actor passes. */
const anyReader: QueryPolicy = {
  kind: 'allow',
  label: 'post:read',
  permissions: [],
  children: [],
  run: ({ actor }) =>
    actor !== null
      ? { allowed: true }
      : { allowed: false, reason: 'signed out', code: 'X_UNAUTHENTICATED' },
};

const orgFeed = channel('tenant-org-feed', {
  params: ['orgId'],
  catchUp: { name: 'tenantOrgFeed' },
  policy: anyReader,
  records: [posts],
  events: true,
});
/** No param names a tenant column: the policy alone decides, as before. */
const room = channel('tenant-room', {
  params: ['roomId'],
  catchUp: { name: 'tenantRoom' },
  policy: anyReader,
  events: true,
});

type Wire = { readonly type: string } & Record<string, unknown>;

class FakeWs implements WsLike {
  readonly frames: Wire[] = [];
  send(data: string): number {
    this.frames.push(JSON.parse(data) as Wire);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
  of(type: string): Wire[] {
    return this.frames.filter((frame) => frame.type === type);
  }
}

let sockets: SocketRegistry;
let hub: ChannelHub;

beforeEach(() => {
  sockets = new SocketRegistry();
  hub = new ChannelHub({ transport: new InProcessTransport(), sockets, channels: [orgFeed, room] });
});

function connect(actor: Actor): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({ ws, clientBuildId: 'b', serverBuildId: 'b', actor });
  sockets.add(socket);
  return { socket, ws };
}

const insert = (orgId: string): ChangeEvent => ({
  table: 'channel_tenant_posts',
  op: 'insert',
  before: null,
  after: { id: '00000000-0000-4000-8000-000000000001', orgId, title: 'quarterly numbers' },
  lsn: '0000000000000001',
  txid: '1',
  orgId,
  at: 0,
  write: null,
});

const joinFeed = (socket: SyncSocket, orgId: string) =>
  hub.subscribeChannel(socket, { kind: 'channel', channel: 'tenant-org-feed', params: { orgId } });

/** Everything a tenant-B member would see: a record, an app event, a presence roster. */
async function trafficOnB(): Promise<void> {
  hub.deliverChange(insert(ORG_B));
  await hub.publishEvent(orgFeed, { orgId: ORG_B }, { typing: true });
  await hub.emit(orgFeed.topic({ orgId: ORG_B }), presenceEvent('join', []));
}

describe('a records channel keyed by the tenant column', () => {
  test("an org-A member naming org B's param is refused and sees no records, events or presence", async () => {
    const alice = connect(userActor({ id: 'alice', orgId: ORG_A }));
    const witness = connect(userActor({ id: 'bob', orgId: ORG_B }));
    await joinFeed(witness.socket, ORG_B);

    const refusal = await joinFeed(alice.socket, ORG_B).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TopicForbiddenError);
    expect((refusal as TopicForbiddenError).cause).toContain('X_TENANCY_ACTOR_MISMATCH');

    await trafficOnB();
    expect(alice.ws.of('records')).toEqual([]);
    expect(alice.ws.of('events')).toEqual([]);
    // The witness proves the traffic was real: org B's own member received all three.
    expect(witness.ws.of('records')).toHaveLength(1);
    expect(witness.ws.of('events')).toHaveLength(2);
  });

  test('a same-org subscribe still receives its records and events', async () => {
    const bob = connect(userActor({ id: 'bob', orgId: ORG_B }));
    await joinFeed(bob.socket, ORG_B);
    await trafficOnB();
    expect(bob.ws.of('records')).toHaveLength(1);
    expect(bob.ws.of('events')).toHaveLength(2);
  });

  test('an actor carrying no org is refused on a tenant channel', async () => {
    const orphan = connect(userActor({ id: 'orphan' }));
    const refusal = await joinFeed(orphan.socket, ORG_B).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TopicForbiddenError);
    expect((refusal as TopicForbiddenError).cause).toContain('X_TENANCY_ACTOR_ORG_REQUIRED');
    await trafficOnB();
    expect(orphan.ws.frames.filter((f) => f.type === 'records' || f.type === 'events')).toEqual([]);
  });

  test('a re-auth into another org drops the seat', async () => {
    const carol = connect(userActor({ id: 'carol', orgId: ORG_B }));
    const name = await joinFeed(carol.socket, ORG_B);
    const dropped = await hub.onActorChange(carol.socket, userActor({ id: 'carol', orgId: ORG_A }));
    expect(dropped).toEqual([name]);
  });
});

describe('a channel with no tenant param', () => {
  test('is decided by its policy alone, an org-less actor included', async () => {
    const orphan = connect(userActor({ id: 'orphan' }));
    await hub.subscribeChannel(orphan.socket, {
      kind: 'channel',
      channel: 'tenant-room',
      params: { roomId: 'lobby' },
    });
    await hub.publishEvent(room, { roomId: 'lobby' }, { wave: true });
    expect(orphan.ws.of('events')).toHaveLength(1);
  });
});
