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
import { createEntry, type QueryEntry } from './query-window';
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
  const entry = createEntry('liveFeed:1', definition, input, definition.matcher(input));
  entry.rows = seated;
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
  entity: 'posts',
  op: 'update',
  before: { id: 'p1', orgId: 'o1', likes: 0 },
  after: { id: 'p1', orgId: 'o1', likes: 1 },
  lsn,
  at: 0,
  orgId: 'o1',
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
    const entry = createEntry('liveFeed:1', definition, input, definition.matcher(input));

    expect(snapshotFrame(entry, 's1', seated, makeCursor(entry.qid, '', seated, 0))).toMatchObject({
      entity: 'posts',
    });
  });
});
