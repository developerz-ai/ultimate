// The retained ring's floor, through real `LiveQueryRegistry` nodes wired the way the CLI wires
// them: a snapshot claims the node's own last-seen position. Each case is a resume that was
// answered with a delta it could not vouch for, or refused a delta it could.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { LiveCursor } from './cursor';
import type { JsonValue, Row } from './json';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import type { Frame } from './sync-protocol';

const clock = frozenClock(new Date('2026-10-02T12:00:00.000Z'));
const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });
const input: JsonValue = { orgId: 'o1' };

const ws: WsLike = {
  send: (data: string) => data.length,
  close: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
  getBufferedAmount: () => 0,
};
let sockets = 0;
const socket = (who = 'carol'): SyncSocket => {
  sockets += 1;
  return new SyncSocket({
    ws,
    id: `s-${sockets}`,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: actor(who),
    clock,
  });
};

/** The table every node reads. A write lands here whether or not a node hears the change. */
interface Table {
  rows: Row[];
}

interface Node {
  readonly registry: LiveQueryRegistry;
  reads(): number;
  cold(): Promise<{ frame: Frame; cursor: LiveCursor; sid: string; socket: SyncSocket }>;
  resume(cursor: LiveCursor): Promise<Frame>;
}

function node(table: Table): Node {
  let reads = 0;
  const registry: LiveQueryRegistry = new LiveQueryRegistry({
    source: new RingChangeBuffer(),
    clock,
  });
  registry.register({
    name: 'liveFeed',
    entities: ['posts'],
    // What `registerLiveQueries` wires: the position is the node's newest RECEIVED change.
    snapshot: async () => {
      reads += 1;
      return { rows: [...table.rows], lsn: registry.lastLsn };
    },
    visible: () => true,
    matcher: () => ({
      entities: ['posts'],
      match: (change) => {
        const patch = patchFromChange(change);
        return { patches: patch ? [patch] : [], refill: false };
      },
    }),
  });
  let sids = 0;
  return {
    registry,
    reads: () => reads,
    async cold() {
      sids += 1;
      const held = socket();
      const sid = `sid-${sids}`;
      const { frame } = await registry.subscribe({ socket: held, name: 'liveFeed', input, sid });
      if (frame.type !== 'snapshot') return expect.unreachable('a cold start is a snapshot');
      return { frame, cursor: frame.cursor, sid, socket: held };
    },
    async resume(cursor) {
      sids += 1;
      const { frame } = await registry.subscribe({
        socket: socket(),
        name: 'liveFeed',
        input,
        sid: `sid-${sids}`,
        cursor,
      });
      return frame;
    },
  };
}

const write = (table: Table, row: Row, lsn: number): ChangeEvent => {
  const before = table.rows.find((held) => held.id === row.id) ?? null;
  table.rows = [...table.rows.filter((held) => held.id !== row.id), row];
  return {
    entity: 'posts',
    op: before === null ? 'insert' : 'update',
    before,
    after: row,
    lsn: formatLsn(lsn),
    txid: String(lsn),
    orgId: 'o1',
    at: clock.now().getTime(),
  };
};

const post = (id: string, title: string): Row => ({ id, orgId: 'o1', title });
const titles = (frame: Frame): unknown[] =>
  frame.type === 'snapshot' ? frame.rows.map((row) => row['title']).sort() : [];

describe('a read served from a window that is already filled', () => {
  test('does not move the floor: another subscriber joining leaves every resume a delta', async () => {
    const table: Table = { rows: [post('p1', 'v1')] };
    const n = node(table);
    await n.registry.deliver(write(table, post('p0', 'seed'), 0xc9));
    await n.cold(); // keeps the entry, and its ring, alive
    const a = await n.cold();
    expect(a.cursor.lsn).toBe(formatLsn(0xc9));
    n.registry.unsubscribe(a.socket.id, a.sid);
    await n.registry.deliver(write(table, post('p2', 'two'), 0xca));
    await n.registry.deliver(write(table, post('p3', 'three'), 0xcb));

    // One unrelated cold subscriber of the same query: its read lands on a window already filled.
    await n.cold();
    const reads = n.reads();
    const resumed = await n.resume(a.cursor);

    expect(resumed.type).toBe('patch');
    expect(resumed.type === 'patch' && resumed.patches.map((patch) => patch.id)).toEqual([
      'p2',
      'p3',
    ]);
    // And the resume itself cost no read at all.
    expect(n.reads()).toBe(reads);
  });
});

describe('a window re-read after the node missed a change', () => {
  /** A holds lsn 1 and drops; the bus drops; row `m` commits unseen; the node invalidates. */
  const afterGap = async (): Promise<{ n: Node; held: LiveCursor }> => {
    const table: Table = { rows: [] };
    const n = node(table);
    await n.registry.deliver(write(table, post('p1', 'v1'), 1));
    await n.cold();
    const a = await n.cold();
    expect(a.cursor.lsn).toBe(formatLsn(1));
    n.registry.unsubscribe(a.socket.id, a.sid);
    table.rows = [...table.rows, post('m', 'missed')];
    n.registry.invalidate();
    return { n, held: a.cursor };
  };

  test('a resume at the re-read position is refused: the cursor cannot say which side it is on', async () => {
    const { n, held } = await afterGap();
    // B cold-subscribes first: the forced read lands, and its position is still lsn 1.
    const b = await n.cold();
    expect(titles(b.frame)).toEqual(['missed', 'v1']);

    const resumed = await n.resume(held);

    expect(resumed.type).toBe('snapshot');
    expect(titles(resumed)).toEqual(['missed', 'v1']);
  });

  test('a resume onto the still-stale entry is a cold start, never a delta out of the old ring', async () => {
    const { n, held } = await afterGap();

    const resumed = await n.resume(held);

    expect(resumed.type).toBe('snapshot');
    expect(titles(resumed)).toEqual(['missed', 'v1']);
  });

  test('a cursor minted BY the re-read is refused too, at the cost of one shared read', async () => {
    const { n } = await afterGap();
    const b = await n.cold();

    expect((await n.resume(b.cursor)).type).toBe('snapshot');
  });
});

describe('a node that has received no change', () => {
  test('answers a foreign cursor with a snapshot: it holds no position that cursor is inside', async () => {
    const table: Table = { rows: [] };
    const nodeA = node(table);
    await nodeA.registry.deliver(write(table, post('p1', 'v1'), 0x78));
    const client = await nodeA.cold();
    expect(client.cursor.lsn).toBe(formatLsn(0x78));

    // p1 becomes v2 before node B starts, so B never hears it. Someone cold-subscribes on B.
    table.rows = [post('p1', 'v2')];
    const nodeB = node(table);
    await nodeB.cold();

    const resumed = await nodeB.resume(client.cursor);

    expect(resumed.type).toBe('snapshot');
    expect(titles(resumed)).toEqual(['v2']);
  });

  test('still resumes the cursor its own read minted, and a foreign one from its first patch on', async () => {
    const table: Table = { rows: [post('p1', 'v1')] };
    const fresh = node(table);
    const own = await fresh.cold();
    await fresh.cold();
    fresh.registry.unsubscribe(own.socket.id, own.sid);
    const change = write(table, post('p2', 'two'), 0x90);
    await fresh.registry.deliver(change);

    const mine = await fresh.resume(own.cursor);
    expect(mine.type === 'patch' && mine.patches.map((patch) => patch.id)).toEqual(['p2']);
    // A cursor another node minted AT that patch has it, and everything after it is retained.
    const theirs = await fresh.resume({ ...own.cursor, lsn: change.lsn });
    expect(theirs.type === 'patch' && theirs.patches).toEqual([]);
    // One from before it is a history this node never held.
    expect((await fresh.resume({ ...own.cursor, lsn: formatLsn(0x80) })).type).toBe('snapshot');
  });

  test('two fresh nodes never mint the same position', async () => {
    const table: Table = { rows: [post('p1', 'v1')] };
    const one = await node(table).cold();
    const other = node(table);
    await other.cold();

    expect((await other.resume(one.cursor)).type).toBe('snapshot');
  });
});
