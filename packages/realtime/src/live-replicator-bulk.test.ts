// A filtered write (`updateWhere`/`deleteWhere`) is reported as a bulk fact, not as rows: the
// replicator marks the windows over THAT entity stale and the next change repairs them. Driven
// through the real path — repository → row observer → replicator → registry → frames — because the
// defect this pins lived in the seam between them: the refill already held the change, the fanout
// dropped it as stale, and the desynced subscriber was never re-snapshotted.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, createContext, runWithContext, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  setRowObserver,
  text,
  uuid,
} from '@ultimat3/entity';
import { from, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { type LiveReplicator, startLiveReplicator } from './live-replicator';
import { OPEN_POLICY } from './policy-fake-fixture';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const ACME = '00000000-0000-4000-8000-0000000000a1';

const events = entity('bulk_events', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 40 }) },
});
const tags = entity('bulk_tags', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 40 }) },
});
type Event = typeof events.$row;
type Tag = typeof tags.$row;

const driver = memoryDriver();
const db = database({ events, tags }, { driver });

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

const member: Actor = userActor({ id: 'ada', orgId: ACME });
const asMember = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: member }), run);
const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const insertEvent = (n: number, label: string): Promise<Event> =>
  asMember(() => db.events.insert({ id: idOf(n), orgId: ACME, label }));
const insertTag = (n: number, label: string): Promise<Tag> =>
  asMember(() => db.tags.insert({ id: idOf(n), orgId: ACME, label }));

/** Every label the client now holds: the last snapshot, then every patch folded after it. */
const held = (ws: FakeWs): readonly unknown[] => {
  const rows = new Map<string, unknown>();
  for (const frame of ws.frames) {
    if (frame.type === 'snapshot') {
      rows.clear();
      for (const row of frame.rows) rows.set(String(row.id), row['label']);
    }
    if (frame.type === 'patch') {
      for (const patch of frame.patches) {
        if (patch.op === 'delete') rows.delete(patch.id);
        else rows.set(patch.id, patch.row?.['label'] ?? rows.get(patch.id));
      }
    }
  }
  return [...rows.values()];
};

let registry: LiveQueryRegistry;
let replicator: LiveReplicator;
let reads: { events: number; tags: number };

beforeEach(async () => {
  resetRegistry();
  driver.reset?.();
  reads = { events: 0, tags: 0 };
  const liveEvents = query({
    input: t.object({}),
    policy: OPEN_POLICY,
    live: true,
    sql: () =>
      from<Event>('bulk_events', () => {
        reads.events += 1;
        return db.events.orderBy('id').limit(50).all();
      })
        .orderBy('id')
        .limit(50),
  });
  const liveTags = query({
    input: t.object({}),
    policy: OPEN_POLICY,
    live: true,
    sql: () =>
      from<Tag>('bulk_tags', () => {
        reads.tags += 1;
        return db.tags.orderBy('id').limit(50).all();
      })
        .orderBy('id')
        .limit(50),
  });
  registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
  const ctx = createContext({ role: 'sync', buildId: 'b' });
  // Wired as `role-sync.ts` wires it: a snapshot claims the newest change the node has received.
  // That claim is what made the refill's lsn EQUAL the change's, and the change look stale.
  const lsn = (): string => registry.lastLsn;
  registry.register(liveQueryDefinition(registerQuery('liveEvents', liveEvents), { ctx, lsn }));
  registry.register(liveQueryDefinition(registerQuery('liveTags', liveTags), { ctx, lsn }));
  replicator = await startLiveReplicator({ registry });
});

afterEach(() => {
  replicator.stop();
  setRowObserver(null);
});

afterAll(() => {
  clearRegistry();
  resetRegistry();
});

const subscribe = async (name: string): Promise<FakeWs> => {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id: `s-${name}`,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: member,
  });
  // The node sends the subscribe reply itself (`sync-frames.ts`); the registry only builds it.
  const { frame } = await registry.subscribe({ socket, name, input: {} });
  socket.send(frame);
  return ws;
};

describe('a bulk write never costs a subscriber the change after it', () => {
  test('updateWhere on the SAME table, then an insert: the subscriber holds both', async () => {
    await insertEvent(1, 'started');
    const ws = await subscribe('liveEvents');
    await asMember(() => db.events.updateWhere({ label: 'started' }, { label: 'running' }));
    await replicator.settled();
    await insertEvent(2, 'step');
    await replicator.settled();

    expect(held(ws)).toEqual(['running', 'step']);
  });

  test('updateWhere on an UNRELATED table, then an insert: the subscriber holds it', async () => {
    await insertEvent(1, 'started');
    await insertTag(9, 'blue');
    const ws = await subscribe('liveEvents');
    await asMember(() => db.tags.updateWhere({ label: 'blue' }, { label: 'red' }));
    await replicator.settled();
    await insertEvent(2, 'step');
    await replicator.settled();

    expect(held(ws)).toEqual(['started', 'step']);
  });

  test('deleteWhere on the same table, then an insert: the deleted row is gone, the new one held', async () => {
    await insertEvent(1, 'started');
    const ws = await subscribe('liveEvents');
    await asMember(() => db.events.deleteWhere({ label: 'started' }));
    await replicator.settled();
    await insertEvent(2, 'step');
    await replicator.settled();

    expect(held(ws)).toEqual(['step']);
  });

  test('a bulk write to one table does not re-read a window over another', async () => {
    await insertEvent(1, 'started');
    await insertTag(9, 'blue');
    const eventsWs = await subscribe('liveEvents');
    const tagsWs = await subscribe('liveTags');
    expect(reads).toEqual({ events: 1, tags: 1 });

    await asMember(() => db.tags.updateWhere({ label: 'blue' }, { label: 'red' }));
    await replicator.settled();
    await insertEvent(2, 'step');
    await insertTag(10, 'green');
    await replicator.settled();

    // The tags window is re-read once, by the change after its bulk write; the events window never.
    expect(reads).toEqual({ events: 1, tags: 2 });
    expect(eventsWs.frames.filter((frame) => frame.type === 'snapshot')).toHaveLength(1);
    expect(held(eventsWs)).toEqual(['started', 'step']);
    expect(held(tagsWs)).toEqual(['red', 'green']);
  });
});
