// What one change does inside one entry's lane. The rule under test: a window that lost its tail
// repairs NOBODY — a re-snapshot out of a guessed window clears the one mark that would have made
// the next change re-read, which is the silent divergence `desynced` and `stale` both exist to stop.

import { describe, expect, test } from 'bun:test';
import { systemClock, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import { makeCursor } from './cursor';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition, LiveSubscription } from './live-contract';
import { type FanoutDeps, fanoutChange, snapshotFrame } from './live-fanout';
import type { BridgeResult } from './matcher-bridge';
import { type QueryEntry, queryEntry } from './query-window';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { SubscriberGate } from './subscriber-gate';
import { decode, type Frame } from './sync-protocol';

const input: JsonValue = { orgId: 'o1' };
const seated: readonly Row[] = [
  { id: 'p1', orgId: 'o1', likes: 0 },
  { id: 'p2', orgId: 'o1', likes: 0 },
];

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  buffered = 0;
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
}

function connect(): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id: 'alice', orgId: 'o1' }),
  });
  new SocketRegistry().add(socket);
  return { socket, ws };
}

/**
 * An entry whose matcher answers whatever the test hands it, and whose read answers a window the
 * test names. `reads` counts the DB round trips so a refill is a number rather than a guess.
 */
function rig(
  match: () => BridgeResult,
  refilled: readonly Row[] = seated,
): { entry: QueryEntry; deps: FanoutDeps; reads: () => number } {
  let reads = 0;
  const definition: LiveQueryDefinition = {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: async () => {
      reads += 1;
      return { rows: refilled, lsn: '' };
    },
    visible: () => true,
    matcher: () => ({ entities: ['posts'], match }),
  };
  const entry = queryEntry('liveFeed:1', definition, input, definition.matcher(input));
  entry.rows = seated;
  // As a landed read leaves it: a window no read has filled is never patched.
  entry.generation = 1;
  entry.applied = 1;
  return {
    entry,
    deps: {
      gate: new SubscriberGate({}),
      source: new RingChangeBuffer(),
      clock: systemClock,
    },
    reads: () => reads,
  };
}

function subscribe(entry: QueryEntry, socket: SyncSocket, sid: string): LiveSubscription {
  const subscription: LiveSubscription = {
    sid,
    qid: entry.qid,
    socket,
    input,
    definition: entry.definition,
    cursor: makeCursor(entry.qid, entry.lsn, entry.rows, 0),
  };
  entry.subscribers.set(sid, subscription);
  return subscription;
}

const change = (lsn: string): ChangeEvent => ({
  table: 'posts',
  op: 'update',
  before: { id: 'p1', orgId: 'o1', likes: 0 },
  after: { id: 'p1', orgId: 'o1', likes: 1 },
  lsn,
  // One commit per lsn, as `MemoryChangeFeed` numbers them: the txid tracks the position rather
  // than being a constant, so two changes in this file are never the same transaction.
  txid: lsn,
  at: 0,
  orgId: 'o1',
  write: null,
});

const patched: BridgeResult = {
  patches: [{ op: 'update', id: 'p1', row: { id: 'p1', likes: 1 }, lsn: '1' }],
  refill: false,
};

/** The matcher lost the window's tail: the patches it did produce are a partial answer. */
const lostTail: BridgeResult = {
  patches: [{ op: 'delete', id: 'p2', row: null, lsn: '1' }],
  refill: true,
};

describe('a lost tail degrades every subscriber the same way', () => {
  test('a desynced subscriber is NOT repaired out of a window this fanout distrusts', async () => {
    const { entry, deps } = rig(() => lostTail);
    const alice = connect();
    const subscription = subscribe(entry, alice.socket, 's1');
    // Diverged for some earlier reason — backpressure, a gate that raised. The next delivery owes
    // it a snapshot out of the shared window, and this delivery has just made that window a guess.
    alice.socket.markDesynced('s1');

    const result = await fanoutChange(deps, entry, change('1'));

    expect(result.sent).toBe(0);
    expect(alice.ws.frames).toHaveLength(0);
    // The mark is what makes the NEXT change re-read. Cleared against a guessed window, this
    // subscriber is recorded as repaired and never re-reads again.
    expect(alice.socket.desynced.has('s1')).toBe(true);
    expect(entry.stale).toBe(true);
    expect(subscription.cursor.lsn).toBe('');
  });

  test('and the next change refills the window first, then repairs it out of the real rows', async () => {
    let answer: BridgeResult = lostTail;
    const { entry, deps, reads } = rig(() => answer, seated);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    alice.socket.markDesynced('s1');

    await fanoutChange(deps, entry, change('1'));
    expect(reads()).toBe(0);

    answer = patched;
    const second = await fanoutChange(deps, entry, change('2'));

    // One read, taken at the top of the lane, and the repair is a snapshot of what it returned.
    expect(reads()).toBe(1);
    expect(second.sent).toBe(1);
    expect(alice.ws.frames).toHaveLength(1);
    // `p2` is the row the guessed window had already dropped. It is back, which is the whole point:
    // under the old order this subscriber was snapshotted without it and then handed a patch.
    expect(alice.ws.frames[0]).toMatchObject({
      type: 'snapshot',
      sid: 's1',
      rows: [
        { id: 'p1', orgId: 'o1', likes: 1 },
        { id: 'p2', orgId: 'o1', likes: 0 },
      ],
    });
    expect(alice.socket.desynced.has('s1')).toBe(false);
  });

  test('a healthy subscriber is marked and sent nothing, which is what it always did', async () => {
    const { entry, deps } = rig(() => lostTail);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');

    const result = await fanoutChange(deps, entry, change('1'));

    expect(result.sent).toBe(0);
    expect(alice.ws.frames).toHaveLength(0);
    expect(alice.socket.desynced.has('s1')).toBe(true);
  });
});

describe('a change the window already holds never reaches a subscriber', () => {
  test('an lsn at or below the window is dropped and counted, not folded', async () => {
    const { entry, deps } = rig(() => patched);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    entry.lsn = '5';

    expect(await fanoutChange(deps, entry, change('5'))).toEqual({ sent: 0, stale: 1 });
    expect(await fanoutChange(deps, entry, change('4'))).toEqual({ sent: 0, stale: 1 });
    expect(alice.ws.frames).toHaveLength(0);

    // …and one strictly above it is not.
    expect(await fanoutChange(deps, entry, change('6'))).toEqual({ sent: 1, stale: 0 });
    expect(alice.ws.frames).toHaveLength(1);
  });

  test('a desynced subscriber is repaired out of the window the lane already holds — no DB read', async () => {
    const { entry, deps, reads } = rig(() => patched);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    alice.socket.markDesynced('s1');

    const result = await fanoutChange(deps, entry, change('1'));

    expect(reads()).toBe(0);
    expect(result.sent).toBe(1);
    expect(alice.ws.frames[0]).toMatchObject({ type: 'snapshot', sid: 's1' });
    expect(alice.socket.desynced.has('s1')).toBe(false);
  });

  test('a send the socket refuses leaves the mark, which is the state it is in', async () => {
    const { entry, deps } = rig(() => patched);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    alice.socket.markDesynced('s1');
    alice.ws.buffered = 8 * 1024 * 1024;

    const result = await fanoutChange(deps, entry, change('1'));

    expect(result.sent).toBe(0);
    expect(alice.socket.desynced.has('s1')).toBe(true);
  });
});

describe('a stale window owes EVERY subscriber a snapshot of its re-read', () => {
  // The rig's read answers `seated` with lsn '' — a definition with no feed position, so the lsn
  // guard cannot decide whether the read already holds the change.
  test('a change the shape does not read still repairs them: nothing else will', async () => {
    const { entry, deps, reads } = rig(() => patched);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    entry.stale = true;

    const result = await fanoutChange(deps, entry, { ...change('1'), table: 'comments' });

    expect(reads()).toBe(1);
    expect(result.sent).toBe(1);
    expect(alice.ws.frames[0]).toMatchObject({ type: 'snapshot', sid: 's1', rows: seated });
    expect(alice.socket.desynced.has('s1')).toBe(false);
  });

  test('a subscriber nobody marked — the window went stale on a failed read — is repaired too', async () => {
    const { entry, deps } = rig(() => patched);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    entry.stale = true;
    entry.lsn = '1';

    // A read with an lsn that claims the change: nothing to patch, and still a snapshot owed.
    entry.definition.snapshot = async () => ({ rows: seated, lsn: '2' });
    const result = await fanoutChange(deps, entry, change('2'));

    expect(result).toEqual({ sent: 1, stale: 0 });
    expect(alice.ws.frames).toHaveLength(1);
    expect(alice.ws.frames[0]).toMatchObject({ type: 'snapshot', sid: 's1' });
  });
});

describe('snapshotFrame is the one place the identity scope is decided', () => {
  test('an entry that names no entity ships no `entity` key at all', () => {
    const { entry } = rig(() => patched);
    const frame = snapshotFrame(entry, 's1', seated, makeCursor(entry.qid, '', seated, 0));

    expect(frame).not.toHaveProperty('entity');
    expect(frame).toMatchObject({ type: 'snapshot', sid: 's1', rows: seated });
  });

  test('an entry that names one ships it, so the client can share rows under it', () => {
    const definition: LiveQueryDefinition = {
      name: 'liveFeed',
      entities: ['posts'],
      snapshot: async () => ({ rows: seated, lsn: '' }),
      visible: () => true,
      matcher: () => ({ entities: ['posts'], match: () => patched }),
      rowEntity: () => 'posts',
    };
    const entry = queryEntry('liveFeed:1', definition, input, definition.matcher(input));

    expect(snapshotFrame(entry, 's1', seated, makeCursor(entry.qid, '', seated, 0))).toMatchObject({
      entity: 'posts',
    });
  });
});

describe('a live row travels under its RECORD key', () => {
  /** A composite-key entity's projection, as `liveRecords` hands it over: `orgId:id`. */
  const composite = (row: Row): string => `${String(row['orgId'])}:${row.id}`;

  function keyed(): QueryEntry {
    const definition: LiveQueryDefinition = {
      name: 'liveFeed',
      entities: ['posts'],
      snapshot: async () => ({ rows: seated, lsn: '' }),
      visible: () => true,
      matcher: () => ({ entities: ['posts'], match: () => patched }),
      rowEntity: () => 'posts',
      rowKey: () => composite,
    };
    const entry = queryEntry('liveFeed:1', definition, input, definition.matcher(input));
    entry.rows = seated;
    entry.generation = 1;
    entry.applied = 1;
    return entry;
  }

  test('a snapshot carries `keys` parallel to its rows when a key is not the id', () => {
    const entry = keyed();
    const frame = snapshotFrame(entry, 's1', seated, makeCursor(entry.qid, '', seated, 0));
    expect(frame).toMatchObject({ keys: ['o1:p1', 'o1:p2'] });
  });

  test('an entity keyed by id sends the frame it always sent — no `keys`', () => {
    const { entry } = rig(() => patched);
    const byId = { ...entry, rowKey: (row: Row) => row.id };
    expect(
      snapshotFrame(byId, 's1', seated, makeCursor(entry.qid, '', seated, 0)),
    ).not.toHaveProperty('keys');
  });

  test('a patch is keyed from the change WHOLE row — the patch itself holds only what changed', async () => {
    const entry = keyed();
    const deps: FanoutDeps = {
      gate: new SubscriberGate({}),
      source: new RingChangeBuffer(),
      clock: systemClock,
    };
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    await fanoutChange(deps, entry, change('1'));
    const sent = alice.ws.frames.find((frame) => frame.type === 'patch');
    expect(sent?.type === 'patch' && sent.patches[0]?.key).toBe('o1:p1');
  });
});

// A TRUNCATE was decoded and dropped: with `FOR ALL TABLES`, every window and every client kept the
// truncated rows until something else happened to touch the query.
describe('a truncate empties the window it reads from', () => {
  const truncate = (lsn: string): ChangeEvent => ({
    table: 'posts',
    op: 'truncate',
    before: null,
    after: null,
    lsn,
    txid: lsn,
    at: 0,
    orgId: null,
    write: null,
  });

  test('the window is re-read now and every subscriber is re-snapshotted out of it', async () => {
    const { entry, deps, reads } = rig(() => patched, []);
    const alice = connect();
    subscribe(entry, alice.socket, 's1');

    const result = await fanoutChange(deps, entry, truncate('9'));

    expect(reads()).toBe(1);
    expect(entry.rows).toEqual([]);
    expect(result.sent).toBe(1);
    expect(alice.ws.frames[0]).toMatchObject({ type: 'snapshot', sid: 's1', rows: [] });
    expect(alice.socket.desynced.has('s1')).toBe(false);
  });

  test('a window that reads another relation is untouched', async () => {
    const { entry, deps, reads } = rig(() => patched, []);
    subscribe(entry, connect().socket, 's1');
    const other = { ...truncate('9'), table: 'comments' };
    expect(await fanoutChange(deps, entry, other)).toEqual({ sent: 0, stale: 0 });
    expect(reads()).toBe(0);
    expect(entry.rows).toEqual(seated);
  });
});

// Postgres logs no bytes for an out-of-line (TOAST) value an UPDATE left untouched, so the change
// names the columns it could not carry (`ChangeEvent.omitted`). A row ENTERING a window from such
// a change would be adopted without them — by the window, by every later snapshot, by the ring.
describe('an add patch lacking a column the change omitted', () => {
  const windowRows: readonly Row[] = [{ id: 'p1', orgId: 'o1', likes: 0, body: 'long text' }];
  const entering: BridgeResult = {
    patches: [
      { op: 'insert', id: 'p9', row: { id: 'p9', orgId: 'o1', likes: 3 }, lsn: '1', index: 0 },
    ],
    refill: false,
  };
  const omitting = (lsn: string, omitted: readonly string[]): ChangeEvent => ({
    ...change(lsn),
    after: { id: 'p9', orgId: 'o1', likes: 3 },
    omitted,
  });

  test('is never delivered or retained: the window is stale and every subscriber re-reads', async () => {
    const { entry, deps } = rig(() => entering);
    entry.rows = windowRows;
    const alice = connect();
    subscribe(entry, alice.socket, 's1');

    const result = await fanoutChange(deps, entry, omitting('1', ['body']));

    expect(result.sent).toBe(0);
    expect(alice.ws.frames).toHaveLength(0);
    expect(entry.stale).toBe(true);
    expect(alice.socket.desynced.has('s1')).toBe(true);
    // A resume must not replay the partial row either.
    expect(deps.source.since(entry.qid, '') ?? []).toEqual([]);
  });

  test('raises the ring floor at once: a resume before the re-read is not a delta lacking the row', async () => {
    let answer: BridgeResult = patched;
    const { entry, deps } = rig(() => answer);
    entry.rows = windowRows;
    subscribe(entry, connect().socket, 's1');
    await fanoutChange(deps, entry, change('1'));
    expect(deps.source.since(entry.qid, '1')).toEqual([]);

    answer = { ...entering, patches: entering.patches.map((patch) => ({ ...patch, lsn: '2' })) };
    await fanoutChange(deps, entry, omitting('2', ['body']));

    // A subscriber at lsn 1 — or at 2, had anyone been sent it — must re-read.
    expect(deps.source.since(entry.qid, '1')).toBeNull();
    expect(deps.source.since(entry.qid, '2')).toBeNull();
  });

  test('the next change re-reads the window and serves the whole row', async () => {
    let answer: BridgeResult = entering;
    const whole: readonly Row[] = [
      { id: 'p9', orgId: 'o1', likes: 3, body: 'kept' },
      ...windowRows,
    ];
    const { entry, deps, reads } = rig(() => answer, whole);
    entry.rows = windowRows;
    const alice = connect();
    subscribe(entry, alice.socket, 's1');
    await fanoutChange(deps, entry, omitting('1', ['body']));
    answer = { patches: [], refill: false };

    await fanoutChange(deps, entry, change('2'));

    expect(reads()).toBe(1);
    const frame = alice.ws.frames.at(-1);
    expect(frame?.type === 'snapshot' && frame.rows[0]).toEqual(whole[0]);
  });

  test('an omitted column the result set does not project changes nothing', async () => {
    const { entry, deps } = rig(() => entering);
    entry.rows = windowRows;
    const alice = connect();
    subscribe(entry, alice.socket, 's1');

    const result = await fanoutChange(deps, entry, omitting('1', ['attachment']));

    expect(result.sent).toBe(1);
    expect(entry.stale).toBe(false);
  });

  test('an update patch is not an add: the window row keeps the column it already holds', async () => {
    const { entry, deps } = rig(() => patched);
    entry.rows = windowRows;
    const alice = connect();
    subscribe(entry, alice.socket, 's1');

    const result = await fanoutChange(deps, entry, { ...change('1'), omitted: ['body'] });

    expect(result.sent).toBe(1);
    expect(entry.stale).toBe(false);
    expect(entry.rows[0]?.['body']).toBe('long text');
  });
});
