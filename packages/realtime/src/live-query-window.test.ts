// What the shared window is not allowed to do: move under a subscriber. Two changes come off the
// bus with no ordering of their own (`sync` fires `void registry.deliver(change)`), and a cold
// subscribe re-reads the query — both write one window that a per-subscriber policy pass is
// awaiting its way through. The rule under test: one lane per query id, and one read per entry.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { queryHash } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import { makeCursor, type ResumeSource } from './cursor';
import type { JsonValue, Row, RowPatch } from './json';
import type { LiveQueryDefinition, SnapshotResult } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
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

/** Ring buffer that refuses one append, so a fanout can fail the way a real one does. */
class FlakyBuffer implements ResumeSource {
  readonly #inner = new RingChangeBuffer();
  failNext = false;

  append(qid: string, patch: RowPatch): void {
    if (this.failNext) {
      this.failNext = false;
      // A `TypeError`, not a bare `Error`: what is simulated is a failure from outside the
      // framework, and reading it as a policy denial is the bug the gate's classification prevents.
      throw new TypeError('retained window is full');
    }
    this.#inner.append(qid, patch);
  }
  since(qid: string, lsn: string): RowPatch[] | null {
    return this.#inner.since(qid, lsn);
  }
  headLsn(qid: string): string | null {
    return this.#inner.headLsn(qid);
  }
}

const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });
const input: JsonValue = { orgId: 'o1' };
const rows: readonly Row[] = [
  { id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'alice draft', likes: 0 },
  { id: 'p2', orgId: 'o1', ownerId: 'bob', title: 'bob draft', likes: 0 },
];
const bobsRow = rows[1] as Row;

/** Yields the microtask queue `count` times — a gate that is slow without touching the clock. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

function feed(
  hooks: {
    snapshot?: () => Promise<SnapshotResult>;
    visible?: LiveQueryDefinition['visible'];
  } = {},
): LiveQueryDefinition {
  return {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: hooks.snapshot ?? (async () => ({ rows, lsn: formatLsn(1) })),
    visible: hooks.visible ?? (({ actor: subject, row }) => row['ownerId'] === subject?.id),
    matcher() {
      return {
        entities: ['posts'],
        match: (event) => {
          const patch = patchFromChange(event);
          return { patches: patch ? [patch] : [], refill: false };
        },
      };
    },
  };
}

function socketFor(id: string, who: Actor): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: who,
  });
  return { socket, ws };
}

const change = (position: number, after: Row, before: Row | null): ChangeEvent => ({
  entity: 'posts',
  op: 'update',
  before,
  after,
  lsn: formatLsn(position),
  txid: String(position),
  orgId: 'o1',
  at: 1_000,
});

/** One subscriber whose first gate call during a delivery takes ten microtask turns to answer. */
async function feedWithOneSlowGate(): Promise<{
  registry: LiveQueryRegistry;
  ws: FakeWs;
  sid: string;
}> {
  let slowNext = false;
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
    feed({
      visible: async () => {
        if (slowNext) {
          slowNext = false;
          await turns(10);
        }
        return true;
      },
    }),
  );
  const bob = socketFor('s-bob', actor('bob'));
  const { subscription } = await registry.subscribe({
    socket: bob.socket,
    name: 'liveFeed',
    input,
  });
  bob.ws.frames.length = 0;
  slowNext = true;
  return { registry, ws: bob.ws, sid: subscription.sid, socketId: bob.socket.id };
}

describe('a delivery holds the query id it is fanning out', () => {
  test('two changes reach a subscriber in lsn order, however slow the first gate is', async () => {
    const { registry, ws } = await feedWithOneSlowGate();

    // Both start before either finishes — exactly what the bus does. The first one's gate is the
    // slow one, so an unordered fanout hands the client lsn 3 and then asks it to fold lsn 2.
    const first = registry.deliver(change(2, { ...bobsRow, likes: 1 }, bobsRow));
    const second = registry.deliver(change(3, { ...bobsRow, likes: 2 }, { ...bobsRow, likes: 1 }));
    await Promise.all([first, second]);

    expect(ws.frames.map((frame) => (frame.type === 'patch' ? frame.lsn : frame.type))).toEqual([
      formatLsn(2),
      formatLsn(3),
    ]);
  });

  test('the cursor ends on the newest change, never rewound by a slower one', async () => {
    const { registry, sid, socketId } = await feedWithOneSlowGate();

    await Promise.all([
      registry.deliver(change(2, { ...bobsRow, likes: 1 }, bobsRow)),
      registry.deliver(change(3, { ...bobsRow, likes: 2 }, { ...bobsRow, likes: 1 })),
    ]);

    // A rewound cursor is a reconnect that replays patches the client already applied, on top of
    // newer ones it also applied — the row ends up at the older value and stays there.
    expect(registry.subscription(socketId, sid)?.cursor.lsn).toBe(formatLsn(3));
  });

  test('a fanout that throws does not wedge every later change for that query id', async () => {
    const source = new FlakyBuffer();
    const registry = new LiveQueryRegistry({ source }).register(feed({ visible: () => true }));
    const bob = socketFor('s-bob', actor('bob'));
    await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });
    bob.ws.frames.length = 0;

    source.failNext = true;
    await expect(registry.deliver(change(2, { ...bobsRow, likes: 1 }, bobsRow))).rejects.toThrow(
      'retained window is full',
    );

    // The lane chains on a settled shadow precisely so this one still runs.
    await expect(registry.deliver(change(3, { ...bobsRow, likes: 2 }, bobsRow))).resolves.toBe(1);
    expect(bob.ws.frames).toHaveLength(1);
  });
});

describe('the shared window is read once per entry', () => {
  test('subscribers arriving during a read join it instead of issuing their own', async () => {
    let reads = 0;
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      feed({
        snapshot: async () => {
          reads += 1;
          await turns(4);
          return { rows, lsn: formatLsn(1) };
        },
      }),
    );
    const alice = socketFor('s-alice', actor('alice'));
    const bob = socketFor('s-bob', actor('bob'));

    const [first, second] = await Promise.all([
      registry.subscribe({ socket: alice.socket, name: 'liveFeed', input }),
      registry.subscribe({ socket: bob.socket, name: 'liveFeed', input }),
    ]);

    // N cold subscribers on one query id being N reads is the shared window not existing.
    expect(reads).toBe(1);
    if (first.frame.type !== 'snapshot' || second.frame.type !== 'snapshot') {
      expect.unreachable('expected two snapshot frames');
    }
    // One read, two result sets: sharing the read must not share the decision.
    expect(first.frame.rows.map((row) => row.id)).toEqual(['p1']);
    expect(second.frame.rows.map((row) => row.id)).toEqual(['p2']);
  });

  test('the share is per read, not a cache — a later subscriber reads again', async () => {
    let reads = 0;
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      feed({
        snapshot: async () => {
          reads += 1;
          return { rows, lsn: formatLsn(1) };
        },
      }),
    );

    await registry.subscribe({
      socket: socketFor('s-alice', actor('alice')).socket,
      name: 'liveFeed',
      input,
    });
    await registry.subscribe({
      socket: socketFor('s-bob', actor('bob')).socket,
      name: 'liveFeed',
      input,
    });

    // A window kept forever is a window that goes stale the moment one change is missed.
    expect(reads).toBe(2);
  });

  test('a read that resolves behind the fanout does not rewind the window', async () => {
    // The definition always answers at lsn 1 — the shape of a snapshot taken before a change and
    // resolved after it, which is what a slow pool does to every cold subscribe under load.
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(feed());
    const alice = socketFor('s-alice', actor('alice'));
    await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input });
    await registry.deliver(change(5, { ...bobsRow, likes: 9 }, bobsRow));

    const bob = socketFor('s-bob', actor('bob'));
    const { frame } = await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });

    if (frame.type !== 'snapshot') expect.unreachable('expected a snapshot frame');
    // Rewinding would hand this subscriber `likes: 0` at lsn 1 and then never correct it: the
    // change that made it 9 is behind its cursor, so nothing will ever send it again.
    expect(frame.rows).toEqual([{ ...bobsRow, likes: 9 }]);
    expect(frame.cursor.lsn).toBe(formatLsn(5));
  });

  test('a read ahead of the window replaces it', async () => {
    let head: SnapshotResult = { rows, lsn: formatLsn(1) };
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      feed({ snapshot: async () => head }),
    );
    const alice = socketFor('s-alice', actor('alice'));
    await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input });

    head = { rows: [rows[0] as Row, { ...bobsRow, likes: 7 }], lsn: formatLsn(9) };
    const bob = socketFor('s-bob', actor('bob'));
    const { frame } = await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });

    if (frame.type !== 'snapshot') expect.unreachable('expected a snapshot frame');
    expect(frame.rows).toEqual([{ ...bobsRow, likes: 7 }]);
    expect(frame.cursor.lsn).toBe(formatLsn(9));
  });
});

describe('one query id failing costs one query id', () => {
  test('the entries behind it still see the change, and its own subscribers are desynced', async () => {
    const source = new FlakyBuffer();
    const registry = new LiveQueryRegistry({ source }).register(feed({ visible: () => true }));
    const bob = socketFor('s-bob', actor('bob'));
    const carol = socketFor('s-carol', actor('carol'));
    const first = await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });
    const second = await registry.subscribe({
      socket: carol.socket,
      name: 'liveFeed',
      input: { orgId: 'o1', tag: 'other' },
    });
    bob.ws.frames.length = 0;
    carol.ws.frames.length = 0;

    // The first entry's append is the one that blows up. Awaiting one entry at a time, the loop
    // ended here: the second query id never saw this change and nobody was desynced to correct it,
    // so its subscriber kept a cursor below the change and no later flush re-snapshotted it.
    source.failNext = true;
    await expect(registry.deliver(change(2, { ...bobsRow, likes: 1 }, bobsRow))).rejects.toThrow(
      'retained window is full',
    );

    expect(carol.ws.frames).toHaveLength(1);
    expect(bob.socket.desynced.has(first.subscription.sid)).toBe(true);
    expect(carol.socket.desynced.has(second.subscription.sid)).toBe(false);
  });
});

describe('a delta resume decides about whole rows', () => {
  test('an entry nothing has read yet is filled before a patch reaches the rule', async () => {
    const seen: Row[] = [];
    const source = new RingChangeBuffer();
    const registry = new LiveQueryRegistry({ source, clock: frozenClock(1_000) }).register(
      feed({
        snapshot: async () => ({ rows, lsn: formatLsn(3) }),
        visible: ({ row }) => {
          seen.push(row);
          return true;
        },
      }),
    );
    const qid = queryHash('liveFeed', input);
    // The retained window holds pre-policy patches, and an update patch is the changed column plus
    // the id — never the whole row. Nothing has read this entry, so the shared window is empty.
    source.append(qid, { op: 'update', id: 'p2', row: { id: 'p2', likes: 1 }, lsn: formatLsn(2) });
    const bob = socketFor('s-bob', actor('bob'));

    const { frame } = await registry.subscribe({
      socket: bob.socket,
      name: 'liveFeed',
      input,
      cursor: makeCursor(qid, formatLsn(1), rows, 1_000),
    });

    if (frame.type !== 'patch') expect.unreachable('expected a patch frame');
    expect(seen[0]).toEqual({ ...bobsRow, likes: 1 });
    expect(frame.patches).toEqual([
      { op: 'update', id: 'p2', row: { id: 'p2', likes: 1 }, lsn: formatLsn(2) },
    ]);
  });
});
