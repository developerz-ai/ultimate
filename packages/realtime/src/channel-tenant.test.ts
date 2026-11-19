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
import type { ChannelRecordsFrame } from './channel-wire';
import { TopicForbiddenError } from './errors';
import { InProcessTransport } from './fanout';
import type { LiveRow } from './json';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

const posts = entity('channel_tenant_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text() },
});
/** Tenanted rows routed by a param that is NOT the tenant column: one room, any org's rows. */
const messages = entity('channel_tenant_messages', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), roomId: text(), body: text() },
});
/** An untenanted table: no org column, so nothing about its rows is any tenant's. */
const notes = entity('channel_tenant_notes', {
  columns: { id: uuid().primaryKey(), roomId: text(), body: text() },
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

/** Keyed by `roomId`, so the subscribe decides nothing about the rows' tenant. */
const roomFeed = channel('tenant-room-feed', {
  params: ['roomId'],
  catchUp: { name: 'tenantRoomFeed' },
  policy: anyReader,
  records: [messages, notes],
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
  hub = new ChannelHub({
    transport: new InProcessTransport(),
    sockets,
    channels: [orgFeed, room, roomFeed],
  });
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

const MESSAGE_ID = '00000000-0000-4000-8000-0000000000b1';
const message = (orgId: string): LiveRow => ({
  id: MESSAGE_ID,
  orgId,
  roomId: 'lobby',
  body: 'org B payroll',
});
const change = (
  table: string,
  op: 'insert' | 'delete',
  row: LiveRow,
  lsn: string,
  orgId: string | null = null,
): ChangeEvent => ({
  table,
  op,
  before: op === 'delete' ? row : null,
  after: op === 'delete' ? null : row,
  lsn,
  txid: lsn,
  orgId,
  at: 0,
  write: 'w-1',
});
const joinRoom = (socket: SyncSocket, since?: { epoch: string; seq: number }) =>
  hub.subscribeChannel(socket, {
    kind: 'channel',
    channel: 'tenant-room-feed',
    params: { roomId: 'lobby' },
    ...(since === undefined ? {} : { since }),
  });
const isRecords = (frame: Wire): frame is Wire & ChannelRecordsFrame => frame.type === 'records';
/** The `records` frames a socket received, typed as the wire declares them. */
const recordsOf = (ws: FakeWs): ChannelRecordsFrame[] => ws.frames.filter(isRecords);
/** Every record key a socket was handed, adopted or removed, across its `records` frames. */
const keysSeen = (ws: FakeWs): string[] =>
  recordsOf(ws).flatMap((frame) => [
    ...Object.values(frame.adopt ?? {}).flatMap((byKey) => Object.keys(byKey)),
    ...Object.values(frame.remove ?? {}).flat(),
  ]);

describe('a records channel keyed by a non-tenant param', () => {
  test("a records channel keyed by a non-tenant param carries no other tenant's rows", async () => {
    const alice = connect(userActor({ id: 'alice', orgId: ORG_A }));
    const bob = connect(userActor({ id: 'bob', orgId: ORG_B }));
    await joinRoom(alice.socket);
    await joinRoom(bob.socket);

    hub.deliverChange(change('channel_tenant_messages', 'insert', message(ORG_B), '1', ORG_B));
    hub.deliverChange(change('channel_tenant_messages', 'delete', message(ORG_B), '2', ORG_B));

    // Org B's member is handed both: the witness that the traffic was real.
    expect(keysSeen(bob.ws)).toEqual([MESSAGE_ID, MESSAGE_ID]);
    // Org A's member sees the seq advance and nothing else: no row, no key, no write id.
    expect(keysSeen(alice.ws)).toEqual([]);
    const withheld = recordsOf(alice.ws);
    expect(withheld.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(withheld.some((frame) => 'write' in frame)).toBe(false);

    // A later org-A joiner resuming from before both changes is replayed the same nothing.
    const epoch = withheld[0]?.epoch ?? '';
    const carol = connect(userActor({ id: 'carol', orgId: ORG_A }));
    await joinRoom(carol.socket, { epoch, seq: 0 });
    expect(recordsOf(carol.ws).map((frame) => frame.seq)).toEqual([1, 2]);
    expect(keysSeen(carol.ws)).toEqual([]);
    // ...while an org-B joiner resuming the same way is replayed both.
    const dave = connect(userActor({ id: 'dave', orgId: ORG_B }));
    await joinRoom(dave.socket, { epoch, seq: 0 });
    expect(keysSeen(dave.ws)).toEqual([MESSAGE_ID, MESSAGE_ID]);
  });

  test("an untenanted table's rows reach every member, org or none, exactly as before", async () => {
    const alice = connect(userActor({ id: 'alice', orgId: ORG_A }));
    const orphan = connect(userActor({ id: 'orphan' }));
    await joinRoom(alice.socket);
    await joinRoom(orphan.socket);
    const note = { id: MESSAGE_ID, roomId: 'lobby', body: 'hello' };
    hub.deliverChange(change('channel_tenant_notes', 'insert', note, '1'));
    expect(keysSeen(alice.ws)).toEqual([MESSAGE_ID]);
    expect(keysSeen(orphan.ws)).toEqual([MESSAGE_ID]);
    expect(recordsOf(alice.ws)[0]?.write).toBe('w-1');
  });

  test('a member with no org is handed no tenanted row', async () => {
    const orphan = connect(userActor({ id: 'orphan' }));
    await joinRoom(orphan.socket);
    hub.deliverChange(change('channel_tenant_messages', 'insert', message(ORG_B), '1', ORG_B));
    expect(keysSeen(orphan.ws)).toEqual([]);
  });
});
