// The write a `records` frame names, through the in-process chain `x dev` runs on: a repository
// write inside a keyed request (`withWriteOrigin`, which `@ultimat3/action`'s HTTP projection opens
// from the idempotency key) → the row observer → this replicator → a real `ChannelHub` → the frame a
// member's socket receives. A write outside any keyed request names nothing.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { userActor, withWriteOrigin, writeDigest } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  setRowObserver,
  text,
  uuid,
} from '@ultimat3/entity';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import { InProcessTransport } from './fanout';
import { startLiveReplicator } from './live-replicator';
import { OPEN_POLICY } from './policy-fake-fixture';
import { recordPublisher } from './record-publisher';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';

const ORG = '00000000-0000-4000-8000-0000000000a1';

const notes = entity('echoed_notes', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 40 }) },
});
const others = entity('echoed_others', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 40 }) },
});
const orgNotes = channel('echoed-notes', {
  params: ['orgId'],
  catchUp: { name: 'echoedNotes' },
  policy: OPEN_POLICY,
  records: [notes],
});

class FakeWs implements WsLike {
  readonly frames: Record<string, unknown>[] = [];
  send(data: string): number {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

afterEach(() => {
  setRowObserver(null);
});

afterAll(() => {
  clearRegistry();
  clearChannels();
});

/** A real hub with one member seated on `echoed-notes`, the frames that member's socket received. */
async function seated(): Promise<{ hub: ChannelHub; ws: FakeWs }> {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({
    transport: new InProcessTransport(),
    sockets,
    channels: [orgNotes],
  });
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id: 'm1', orgId: ORG }),
  });
  sockets.add(socket);
  await hub.subscribeChannel(socket, {
    kind: 'channel',
    channel: 'echoed-notes',
    params: { orgId: ORG },
  });
  return { hub, ws };
}

const NO_LIVE_QUERIES = { deliver: () => Promise.resolve(0), invalidate: () => 0 } as never;

describe('a records frame, named by the keyed write that produced it', () => {
  test('inside a keyed request the frame carries the digest; outside one it carries none', async () => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({
      transport: new InProcessTransport(),
      sockets,
      channels: [orgNotes],
    });
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor: userActor({ id: 'm1', orgId: ORG }),
    });
    sockets.add(socket);
    await hub.subscribeChannel(socket, {
      kind: 'channel',
      channel: 'echoed-notes',
      params: { orgId: ORG },
    });

    const replicator = await startLiveReplicator({
      registry: { deliver: () => Promise.resolve(0), invalidate: () => 0 } as never,
      channels: hub,
    });
    const db = database({ notes }, { driver: memoryDriver() });
    const key = 'likePost:0192f0c4-0000-7000-8000-000000000001';
    const digest = await writeDigest(key);
    await withWriteOrigin(digest, () =>
      db.notes.insert({ id: '00000000-0000-4000-8000-000000000001', orgId: ORG, label: 'mine' }),
    );
    await db.notes.insert({ id: '00000000-0000-4000-8000-000000000002', orgId: ORG, label: 'job' });
    await replicator.settled();
    replicator.stop();

    const records = ws.frames.filter((frame) => frame['type'] === 'records');
    expect(records).toHaveLength(2);
    expect(records[0]?.['write']).toBe(digest);
    expect(JSON.stringify(records[0])).not.toContain(key);
    expect(Object.hasOwn(records[1] ?? {}, 'write')).toBe(false);
  });
});

// A filtered write names rows the observer never saw, so no `records` frame can carry it. Under
// `x dev` the live-query windows were invalidated and the channels were not: every other tab held
// the pre-update row with nothing ever telling it to re-read. The node pairs the two (`sync-node.ts`).
describe('a bulk write reopens the channels carrying its table', () => {
  test('updateWhere on a channel table tells the member to re-read; one on another table does not', async () => {
    const { hub, ws } = await seated();
    const replicator = await startLiveReplicator({ registry: NO_LIVE_QUERIES, channels: hub });
    const db = database({ notes, others }, { driver: memoryDriver() });
    await db.notes.insert({ id: '00000000-0000-4000-8000-000000000003', orgId: ORG, label: 'a' });
    await db.others.insert({ id: '00000000-0000-4000-8000-000000000004', orgId: ORG, label: 'a' });
    await replicator.settled();
    const gaps = (): number => ws.frames.filter((frame) => frame['type'] === 'replay-gap').length;
    const before = gaps();

    await db.others.updateWhere({ orgId: ORG, label: 'a' }, { label: 'b' });
    await replicator.settled();
    expect(gaps()).toBe(before);

    await db.notes.updateWhere({ orgId: ORG, label: 'a' }, { label: 'b' });
    await replicator.settled();
    replicator.stop();
    expect(gaps()).toBe(before + 1);
  });
});

// An app that publishes an entity itself (`recordPublisher`) is that entity's one channel delivery,
// as it is in production with no replicator. The bridge carrying the same insert as well was every
// insert twice under `x dev` (#682); its live-query half stays, since a publisher feeds no window.
describe('an entity a record publisher claims', () => {
  test('reaches no channel through the bridge, and still reaches the live queries', async () => {
    const { hub, ws } = await seated();
    const delivered: string[] = [];
    const replicator = await startLiveReplicator({
      registry: {
        deliver: (change: { table: string }) => {
          delivered.push(change.table);
          return Promise.resolve(0);
        },
        invalidate: () => 0,
      } as never,
      channels: hub,
    });
    const publisher = recordPublisher({ transport: new InProcessTransport(), entities: [notes] });
    const db = database({ notes }, { driver: memoryDriver() });
    await db.notes.insert({ id: '00000000-0000-4000-8000-000000000005', orgId: ORG, label: 'a' });
    await replicator.settled();
    publisher.close();
    await db.notes.insert({ id: '00000000-0000-4000-8000-000000000006', orgId: ORG, label: 'b' });
    await replicator.settled();
    replicator.stop();

    const records = ws.frames.filter((frame) => frame['type'] === 'records');
    // Only the write made after the claim was released.
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toContain('000000000006');
    expect(delivered).toEqual(['echoed_notes', 'echoed_notes']);
  });
});

// `ChangeEvent.table` is the RELATION, on every producer: the WAL decoder reads it off the
// Relation message, a channel matches `projection.table`, a live shape is `from('<table>', …)`. The
// row observer reports the entity's declared NAME, and the bridge passed it through, so an entity
// adopting a table under another name (`entity('ledger', { table: 'gl_entries' })`) reached no
// channel, no live window and no bulk re-read under `x dev`.
describe('an entity whose table is not its name', () => {
  const ledger = entity('bridged_ledger', {
    table: 'bridged_gl_entries',
    columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 40 }) },
  });
  const ledgerFeed = channel('bridged-ledger', {
    params: ['orgId'],
    catchUp: { name: 'bridgedLedger' },
    policy: OPEN_POLICY,
    records: [ledger],
  });

  test('crosses the bridge under its table: channel records, live windows, bulk re-reads', async () => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({
      transport: new InProcessTransport(),
      sockets,
      channels: [ledgerFeed],
    });
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor: userActor({ id: 'm1', orgId: ORG }),
    });
    sockets.add(socket);
    await hub.subscribeChannel(socket, {
      kind: 'channel',
      channel: ledgerFeed.name,
      params: { orgId: ORG },
    });
    const delivered: string[] = [];
    const invalidated: (string | undefined)[] = [];
    const replicator = await startLiveReplicator({
      registry: {
        deliver: (change: { table: string }) => {
          delivered.push(change.table);
          return Promise.resolve(0);
        },
        invalidate: (table?: string) => {
          invalidated.push(table);
          return 0;
        },
      } as never,
      channels: hub,
    });
    const db = database({ ledger }, { driver: memoryDriver() });
    await db.ledger.insert({ id: '00000000-0000-4000-8000-000000000007', orgId: ORG, label: 'a' });
    await replicator.settled();
    const gaps = (): number => ws.frames.filter((frame) => frame['type'] === 'replay-gap').length;
    const before = gaps();
    await db.ledger.updateWhere({ orgId: ORG, label: 'a' }, { label: 'b' });
    await replicator.settled();
    replicator.stop();

    const records = ws.frames.filter((frame) => frame['type'] === 'records');
    expect(records).toHaveLength(1);
    // Keyed in the store by the entity's NAME, as every record is; matched by its table.
    expect(Object.keys((records[0]?.['adopt'] as object | undefined) ?? {})).toEqual([
      'bridged_ledger',
    ]);
    expect(delivered).toEqual(['bridged_gl_entries']);
    expect(invalidated).toEqual(['bridged_gl_entries']);
    expect(gaps()).toBe(before + 1);
  });
});
