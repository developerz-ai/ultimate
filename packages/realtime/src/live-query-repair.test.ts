// What happens *after* a subscriber has been recorded as diverged, and after this node has missed
// a change. Both marks existed and neither had a reader: `socket.desynced` was written at four call
// sites and read by nothing, and a change stream gap was invisible because the fanout that never
// ran also never moved a window's lsn.
//
// Failure case first in both halves: a diverged subscriber must be repaired, and a skipped
// sequence must desync everyone rather than leaving them silently stale on a healthy socket.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import { formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import { type LiveQueryDefinition, LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });
const input: JsonValue = { orgId: 'o1' };

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  /** Set above the socket's own limit to make every send a backpressure drop. */
  buffered = 0;
  send(raw: string): number {
    this.frames.push(decode(raw));
    return raw.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
}

/** The rows the definition answers with. Mutated by a test to stand for a write it never saw. */
let table: Row[] = [{ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'first' }];
let reads = 0;

const feed: LiveQueryDefinition = {
  name: 'feed',
  entities: ['posts'],
  async snapshot() {
    reads += 1;
    return { rows: [...table], lsn: '' };
  },
  visible() {
    return true;
  },
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

function socketFor(id: string): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  return {
    ws,
    socket: new SyncSocket({
      ws,
      id,
      clientBuildId: 'build-1',
      serverBuildId: 'build-1',
      actor: actor('alice'),
    }),
  };
}

function change(after: Row, position: number): ChangeEvent {
  return {
    entity: 'posts',
    op: 'update',
    before: null,
    after,
    lsn: formatLsn(position),
    txid: String(position),
    orgId: 'o1',
    at: 1_000,
  };
}

function registry(): LiveQueryRegistry {
  table = [{ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'first' }];
  reads = 0;
  return new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(feed);
}

describe('a desynced subscriber is repaired', () => {
  test('the next delivery is a fresh snapshot, not the patch it would have missed', async () => {
    const live = registry();
    const alice = socketFor('s-alice');
    const { subscription } = await live.subscribe({ socket: alice.socket, name: 'feed', input });

    // A patch dropped by backpressure: the socket refuses the frame and records the divergence.
    alice.ws.buffered = 4 * 1024 * 1024;
    await live.deliver(change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'second' }, 2));
    expect(alice.socket.desynced.has(subscription.sid)).toBe(true);

    // The buffer drains. The socket is healthy, and nothing else would ever correct it.
    alice.ws.buffered = 0;
    alice.ws.frames.length = 0;
    await live.deliver(change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'third' }, 3));

    expect(alice.ws.frames.map((frame) => frame.type)).toEqual(['snapshot']);
    const frame = alice.ws.frames[0];
    if (frame?.type !== 'snapshot') expect.unreachable('the repair is a snapshot');
    expect(frame.rows.map((row) => row['title'])).toEqual(['third']);
    expect(alice.socket.desynced.has(subscription.sid)).toBe(false);
    // The cursor follows the frame that was actually sent, or the next resume replays over it.
    expect(subscription.cursor.lsn).toBe(formatLsn(3));
  });

  test('a repair the socket refuses leaves the subscriber diverged, not quietly cleared', async () => {
    const live = registry();
    const alice = socketFor('s-alice');
    const { subscription } = await live.subscribe({ socket: alice.socket, name: 'feed', input });

    alice.ws.buffered = 4 * 1024 * 1024;
    await live.deliver(change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'second' }, 2));
    await live.deliver(change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'third' }, 3));

    expect(alice.socket.desynced.has(subscription.sid)).toBe(true);
  });
});

describe('a gap in the change stream', () => {
  test('invalidate() desyncs every subscriber and the next change re-reads the window', async () => {
    const live = registry();
    const alice = socketFor('s-alice');
    const { subscription } = await live.subscribe({ socket: alice.socket, name: 'feed', input });
    const readsAfterSubscribe = reads;

    // Eleven changes went past while this node's bus connection was down. The window still holds
    // the rows from before them, and no cursor moved, so nothing would ever ask for a re-snapshot.
    table = [
      { id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'twelfth' },
      { id: 'p2', orgId: 'o1', ownerId: 'alice', title: 'inserted while we were away' },
    ];
    expect(live.invalidate()).toBe(1);
    expect(alice.socket.desynced.has(subscription.sid)).toBe(true);

    alice.ws.frames.length = 0;
    await live.deliver(
      change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'thirteenth' }, 20),
    );

    // The repair is served from a *re-read* window: patching the one it held would have compounded
    // the eleven it never saw.
    expect(reads).toBe(readsAfterSubscribe + 1);
    const frame = alice.ws.frames[0];
    if (frame?.type !== 'snapshot') expect.unreachable('a gap is repaired with a snapshot');
    expect(frame.rows.map((row) => row.id)).toEqual(['p1', 'p2']);
  });
});

describe('the consume side refuses a change the window already holds', () => {
  test('a change at or below the window lsn is counted and dropped, never folded again', async () => {
    const live = registry();
    const alice = socketFor('s-alice');
    await live.subscribe({ socket: alice.socket, name: 'feed', input });

    await live.deliver(change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'second' }, 5));
    alice.ws.frames.length = 0;

    // The same change again — a redelivery, or one that arrived behind the snapshot that already
    // included it. Folded a second time it rewinds this subscriber's cursor to it.
    expect(
      await live.deliver(change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'x' }, 5)),
    ).toBe(0);
    expect(
      await live.deliver(change({ id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'y' }, 4)),
    ).toBe(0);

    expect(live.staleChanges).toBe(2);
    expect(alice.ws.frames).toEqual([]);
  });
});
