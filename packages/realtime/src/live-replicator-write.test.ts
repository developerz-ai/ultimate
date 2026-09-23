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
import { OPEN_POLICY } from './policy-fake';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';

const ORG = '00000000-0000-4000-8000-0000000000a1';

const notes = entity('echoed_notes', {
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
