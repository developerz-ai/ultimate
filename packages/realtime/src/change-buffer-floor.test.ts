// The rolling-deploy shape, through two real registries: a cursor minted on one node is resumed
// on another whose ring was born later. The ring answered "in window" for a history it never
// held, so the client folded one patch onto a window missing a change — and stayed wrong on a
// healthy socket, because nothing was ever going to ask again.

import { expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const clock = frozenClock(new Date('2026-08-09T12:00:00.000Z'));
const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });
const input: JsonValue = { orgId: 'o1' };

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

const socketFor = (id: string, who: Actor): SyncSocket =>
  new SyncSocket({
    ws: new FakeWs(),
    id,
    clientBuildId: 'b1',
    serverBuildId: 'b1',
    actor: who,
    clock,
  });

/** The table both nodes read: one row, and the position it was last written at. */
const table = { rows: [{ id: 'p1', orgId: 'o1', title: 'v1' }] as Row[], lsn: 120 };

const liveFeed: LiveQueryDefinition = {
  name: 'liveFeed',
  entities: ['posts'],
  async snapshot() {
    return { rows: table.rows, lsn: formatLsn(table.lsn) };
  },
  visible: () => true,
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

const node = (): LiveQueryRegistry =>
  new LiveQueryRegistry({ source: new RingChangeBuffer(), clock }).register(liveFeed);

const insert = (row: Row, lsn: number): ChangeEvent => ({
  entity: 'posts',
  op: 'insert',
  before: null,
  after: row,
  lsn: formatLsn(lsn),
  txid: String(lsn),
  orgId: 'o1',
  at: clock.now().getTime(),
});

test('a cursor minted on another node is answered with a snapshot, never a partial delta', async () => {
  const nodeA = node();
  const nodeB = node();

  // The client holds p1=v1 at lsn 120, served by node A. Node A then drains.
  const held = await nodeA.subscribe({
    socket: socketFor('s-client-a', actor('carol')),
    name: 'liveFeed',
    input,
    sid: 'c1',
  });
  expect(held.subscription.cursor.lsn).toBe(formatLsn(120));

  // lsn 130 rewrites p1. Node B holds no entry for this query, so it retains nothing of it.
  table.rows = [{ id: 'p1', orgId: 'o1', title: 'v2' }];
  table.lsn = 130;
  await nodeB.deliver(insert({ id: 'p1', orgId: 'o1', title: 'v2' }, 130));

  // Somebody else cold-subscribes on B (snapshot at 130), and lsn 160 inserts p2: B's ring is born.
  await nodeB.subscribe({
    socket: socketFor('s-other', actor('dave')),
    name: 'liveFeed',
    input,
    sid: 'd1',
  });
  await nodeB.deliver(insert({ id: 'p2', orgId: 'o1', title: 'new' }, 160));

  // The client reconnects onto B with the cursor A minted.
  const resumed = await nodeB.subscribe({
    socket: socketFor('s-client-b', actor('carol')),
    name: 'liveFeed',
    input,
    sid: 'c2',
    cursor: held.subscription.cursor,
  });

  // One insert patch would leave it holding p1=v1 forever. The window is what it needs.
  expect(resumed.frame.type).toBe('snapshot');
  if (resumed.frame.type !== 'snapshot') return expect.unreachable();
  expect(resumed.frame.rows.map((row) => row['title']).sort()).toEqual(['new', 'v2']);
});
