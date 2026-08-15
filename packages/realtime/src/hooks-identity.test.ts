// The thesis' identity map, at the tier that ships: one row value per `(entity, id)` for the whole
// client, whoever brought it in and whoever writes it. Two components subscribing to two live
// queries that overlap on one row used to hold two copies of it — one updated, the other rendered
// stale, and nothing said so. These cases are that bug's specification.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { LiveClient } from './client';
import { makeCursor } from './cursor';
import { clearLiveClient, setLiveClient, useLive, useMutation } from './hooks';
import {
  FakeSocket,
  harness,
  likePost,
  liveFeed,
  type PostRow,
  querySids,
  sentMutateKey,
  signal,
  type Tables,
} from './hooks-fixture';
import { MemoryLocalStore } from './local-store';
import { MemoryQueueStore, OfflineQueue } from './offline-queue';
import { RebaseLog } from './rebase';
import { PROTOCOL_VERSION } from './sync-protocol';

beforeEach(() => {
  clearLiveClient();
});

describe('the identity map', () => {
  const livePinned = { name: 'livePinned' };

  function snapshot(socket: FakeSocket, sid: string, rows: readonly PostRow[]): void {
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor(sid, '0'.repeat(24), rows, 1_000),
    });
  }

  test('one row, two overlapping live queries: a patch on one is observed by both', async () => {
    const { client, socket } = await harness();
    client.connect();
    socket.open();
    setLiveClient(client);

    const feed = useLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const pinned = useLive<PostRow>(livePinned, { orgId: 'org-1' });
    const [feedSid = '', pinnedSid = ''] = querySids(socket, 'add');

    snapshot(socket, feedSid, [
      { id: 'p1', likedByMe: false, likeCount: 2 },
      { id: 'p2', likedByMe: false, likeCount: 0 },
    ]);
    snapshot(socket, pinnedSid, [{ id: 'p1', likedByMe: false, likeCount: 2 }]);

    // One object per id, not two rows that happen to be equal.
    expect(feed()[0]).toBe(pinned()[0]);

    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid: feedSid,
      lsn: '1'.repeat(24),
      patches: [{ op: 'update', id: 'p1', row: { likeCount: 3 }, lsn: '1'.repeat(24) }],
    });

    expect(feed()[0]?.likeCount).toBe(3);
    expect(pinned()[0]?.likeCount).toBe(3); // the stale copy that used to be here
    expect(feed()[0]).toBe(pinned()[0]);
    expect(feed()[1]?.likeCount).toBe(0); // a row only one query holds is untouched
  });

  test("a mutator's optimistic twin lands in every live query holding that row", async () => {
    const { client, socket } = await harness();
    client.connect();
    socket.open();
    setLiveClient(client);

    const feed = useLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const [feedSid = ''] = querySids(socket, 'add');
    snapshot(socket, feedSid, [{ id: 'p1', likedByMe: false, likeCount: 2 }]);

    await useMutation({ ...likePost, entity: 'posts' })({ postId: 'p1' });

    // The optimistic write went to the local store; the live query renders the same row.
    expect(feed()[0]?.likeCount).toBe(3);
    expect(feed()[0]?.likedByMe).toBe(true);
  });

  test('a server-wins rebase rolls the optimistic write back in the live query too', async () => {
    // Its own client: a rebase needs the log the mutation was recorded in, which is tier 3's
    // third piece and not every case's business.
    const socket = new FakeSocket();
    const store = new MemoryLocalStore<Tables>({
      posts: [{ id: 'p1', likedByMe: false, likeCount: 2 }],
    });
    const client = new LiveClient<Tables>({
      signal,
      connect: () => socket,
      buildId: 'build-1',
      store,
      queue: await OfflineQueue.open(new MemoryQueueStore()),
      log: new RebaseLog<Tables>(),
      clock: frozenClock(1_000),
      scheduler: () => () => {},
    });
    client.connect();
    socket.open();
    setLiveClient(client);

    const feed = useLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const [feedSid = ''] = querySids(socket, 'add');
    snapshot(socket, feedSid, [{ id: 'p1', likedByMe: false, likeCount: 2 }]);

    await useMutation({ ...likePost, entity: 'posts' })({ postId: 'p1' });
    expect(feed()[0]?.likeCount).toBe(3);

    const key = sentMutateKey(socket);
    socket.deliver({
      type: 'rebase',
      v: PROTOCOL_VERSION,
      key,
      entity: 'posts',
      strategy: 'server-wins',
      row: { id: 'p1', likedByMe: false, likeCount: 2 },
    });

    expect(store.tx.posts.get('p1')?.likeCount).toBe(2);
    expect(feed()[0]?.likeCount).toBe(2);
  });
});
