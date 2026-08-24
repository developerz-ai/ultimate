// What a RECEIVED frame does to client state, driven through a real tier-3 client rather than a
// hand-built target: a patch moves the cursor the next resume is decided from, a refused mutation
// leaves nothing optimistic behind it, and an accepted one leaves nothing optimistic either.
//
// The accepted case is answered by TWO frames whose order is the whole contract, so the cases that
// cover it route the client's own `mutate` frame through the real `createFrameRouter` and deliver
// what comes back, in the order it comes back. A hand-written pair here would pass forever while
// the node sent them the other way round — which is exactly the state this file found them in.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import { ChannelHub } from './channel';
import type { MutatorRef } from './client-contract';
import { defaultReconnectBudget, makeCursor, shouldResnapshot } from './cursor';
import { InProcessTransport } from './fanout';
import {
  bumpRef,
  type FakeSocket,
  flush,
  harness,
  likeRef,
  liveFeed,
  type PostRow,
  querySid,
  type Tables,
} from './hooks-fixture';
import type { Row } from './json';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { createFrameRouter } from './sync-frames';
import { decode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const LSN_0 = '0'.repeat(24);
const LSN_1 = '1'.repeat(24);
const DENIED = { code: 'X_FORBIDDEN', cause: 'denied by policy', fix: 'x policy explain --json' };
const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });

/** `last-write-wins`, with the local write newer by the server's own clock field. */
const lwwRef: MutatorRef<Tables> = {
  name: 'bumpPost',
  entity: 'posts',
  conflict: 'last-write-wins',
  local: (tx) => {
    tx.posts.update('p1', (post) => ({ likeCount: post.likeCount + 10, updatedAt: 200 }));
  },
};

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

/**
 * What a real `sync` node answers the mutate frame this client last sent, in the order it answers
 * it. `result` is what the app's `onMutate` returns — the one thing that decides whether a rebase
 * frame follows the ack at all.
 */
async function answerFor(
  socket: FakeSocket,
  result: { entity?: string; row?: Row | null },
): Promise<readonly Frame[]> {
  const sent = socket
    .frames()
    .filter((frame) => frame.type === 'mutate')
    .at(-1);
  if (sent?.type !== 'mutate') return [];
  const ws = new FakeWs();
  const sockets = new SocketRegistry();
  const node = new SyncSocket({
    ws,
    id: 'sock-1',
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: alice,
  });
  sockets.add(node);
  const route = createFrameRouter({
    hub: new ChannelHub({ transport: new InProcessTransport(), sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    buildId: 'build-1',
    onMutate: async () => ({ lsn: formatLsn(1), ...result }),
  });
  await route(node, sent);
  return ws.frames;
}

describe('a patch frame', () => {
  // `cursor.at` only ever moved on a snapshot, so `shouldResnapshot`'s lag check answered
  // "re-snapshot" for every client connected longer than `maxLagMs` — the delta resume the
  // retained change window exists for, dead exactly during the deploy storm it was built for.
  test('advances the cursor, so a long-lived subscription can still resume from a delta', async () => {
    const { client, socket, clock } = await harness();
    client.connect();
    socket.open();
    const handle = client.useLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const sid = querySid(socket, 'add');
    const rows: readonly PostRow[] = [{ id: 'p1', likedByMe: false, likeCount: 2 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', LSN_0, rows, clock.now().getTime()),
    });

    clock.advance(defaultReconnectBudget.maxLagMs + 60_000);
    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: LSN_1,
      patches: [
        { op: 'insert', id: 'p2', row: { id: 'p2', likedByMe: false, likeCount: 0 }, lsn: LSN_1 },
      ],
    });

    const cursor = handle.cursor();
    expect(cursor?.lsn).toBe(LSN_1);
    expect(cursor?.at).toBe(clock.now().getTime());
    expect([...(cursor?.ids ?? [])]).toEqual(['p1', 'p2']);
    // The property all of that is for: this cursor is still resumable.
    const decision = shouldResnapshot(
      cursor ?? makeCursor('liveFeed', LSN_0, rows, 0),
      [],
      clock.now().getTime(),
    );
    expect(decision).toEqual({ resnapshot: false, reason: 'in-window', cost: 0 });
  });

  test('a tier-1 channel frame carries no lsn, so it never rewinds a cursor', async () => {
    const { client, socket, clock } = await harness();
    client.connect();
    socket.open();
    const handle = client.useLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const sid = querySid(socket, 'add');
    const rows: readonly PostRow[] = [{ id: 'p1', likedByMe: false, likeCount: 2 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows,
      cursor: makeCursor('liveFeed', LSN_1, rows, clock.now().getTime()),
    });

    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: '',
      patches: [{ op: 'update', id: 'p1', row: { likeCount: 3 }, lsn: '' }],
    });

    expect(handle.cursor()?.lsn).toBe(LSN_1);
  });
});

describe('a successful ack', () => {
  // A mutation the server took is no longer optimistic: its journal row cannot be rolled back and
  // its rebase entry must never be replayed again. Neither was ever dropped, so every acked
  // mutation left both behind for the life of the session — unbounded, and on the happy path.
  test('commits the optimistic write: the row stays, the journal and the log entry go', async () => {
    const { client, socket, store, queue, log } = await harness();
    client.connect();
    socket.open();
    await client.mutate(bumpRef, { postId: 'p1' }, 'bump:p1');
    expect(store.pendingKeys()).toEqual(['bump:p1']);
    expect(log.size).toBe(1);

    for (const frame of await answerFor(socket, {})) socket.deliver(frame);
    await flush();

    expect(store.tx.posts.get('p1')?.likeCount).toBe(12); // the server took it: it stays
    expect(store.pendingKeys()).toEqual([]);
    expect(log.size).toBe(0);
    expect(queue.pending()).toHaveLength(0);
  });

  // Straight through the node, in the order the node really sends: the pairing is one decision
  // across two files, and a hand-written "rebase then ack" here would pass forever while the node
  // sent them the other way round.
  test('lands after the rebase, so the mutator conflict strategy is still there to read', async () => {
    const { client, socket, store, queue, log } = await harness();
    client.connect();
    socket.open();
    await client.mutate(lwwRef, { postId: 'p1' }, 'bump:p1');

    const answer = await answerFor(socket, {
      entity: 'posts',
      row: { id: 'p1', likeCount: 99, updatedAt: 100 },
    });
    expect(answer.map((frame) => frame.type)).toEqual(['rebase', 'ack']);
    for (const frame of answer) socket.deliver(frame);
    await flush();

    // `last-write-wins` by the server's own clock field: the local write is newer, so it stands.
    // Read with the log entry already dropped, this is 99 — the strategy silently becomes
    // server-wins and the user's newer write disappears.
    expect(store.tx.posts.get('p1')?.likeCount).toBe(12);
    expect(store.pendingKeys()).toEqual([]);
    expect(log.size).toBe(0);
    expect(queue.pending()).toHaveLength(0);
  });

  test('a rebase for a key nothing recorded can no longer resurrect an acked mutation', async () => {
    const { client, socket, store } = await harness();
    client.connect();
    socket.open();
    await client.mutate(bumpRef, { postId: 'p1' }, 'bump:p1');
    for (const frame of await answerFor(socket, {})) socket.deliver(frame);
    await flush();

    // A duplicate, or the resend a socket death produces. With no entry to read a sequence off,
    // `reconcile` takes `seq >= 0` as "everything still in the log" — so an acked mutation left in
    // it was rolled back to the row it saw before it ran, and replayed on top of server truth.
    socket.deliver({
      type: 'rebase',
      v: PROTOCOL_VERSION,
      key: 'ghost',
      entity: 'posts',
      strategy: 'server-wins',
      row: { id: 'p1', likedByMe: false, likeCount: 99 },
    });
    await flush();

    expect(store.tx.posts.get('p1')?.likeCount).toBe(99);
  });
});

describe('an ack carrying an error', () => {
  // The queue entry was marked failed and NOTHING else happened: the optimistic write stayed on
  // screen forever, its rebase entry leaked, and its journal row with it — a denied mutation that
  // every later reconcile replayed.
  test('rolls the optimistic write back and drops its rebase entry', async () => {
    const { client, socket, store, queue, log } = await harness();
    client.connect();
    socket.open();

    await client.mutate(likeRef, { postId: 'p1' }, 'like:p1');
    expect(store.tx.posts.get('p1')).toEqual({ id: 'p1', likedByMe: true, likeCount: 3 });
    expect(log.size).toBe(1);

    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: 'like:p1',
      lsn: null,
      error: DENIED,
    });
    await flush();

    expect(store.tx.posts.get('p1')).toEqual({ id: 'p1', likedByMe: false, likeCount: 2 });
    expect(log.size).toBe(0);
    expect(store.pendingKeys()).toEqual([]);
    // Kept for the UI, exactly as before — the rollback is what was missing, not the record.
    expect(queue.find('like:p1')?.status).toBe('failed');
    expect(queue.find('like:p1')?.error).toEqual(DENIED);
  });

  test('replays the mutations queued behind it, so only the refused one is lost', async () => {
    const { client, socket, store } = await harness();
    client.connect();
    socket.open();

    await client.mutate(likeRef, { postId: 'p1' }, 'like:p1');
    await client.mutate(bumpRef, { postId: 'p1' }, 'bump:p1');
    expect(store.tx.posts.get('p1')?.likeCount).toBe(13);

    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: 'like:p1',
      lsn: null,
      error: DENIED,
    });
    await flush();

    // 2 (server truth as the client last knew it) + 10 (the mutation nobody refused).
    expect(store.tx.posts.get('p1')).toEqual({ id: 'p1', likedByMe: false, likeCount: 12 });
  });

  test('a denial for a key the log never held changes nothing', async () => {
    const { client, socket, store } = await harness();
    client.connect();
    socket.open();
    await client.mutate(likeRef, { postId: 'p1' }, 'like:p1');

    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: 'like:p9',
      lsn: null,
      error: DENIED,
    });
    await flush();

    expect(store.tx.posts.get('p1')?.likeCount).toBe(3);
  });
});
