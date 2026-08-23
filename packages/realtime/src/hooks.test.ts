// The hooks are the whole surface an app component sees, so this covers the seam rather than the
// client underneath it: the ambient registration and the error when it is missing, the callable
// live accessor, the connection getters that have to stay live, and the two queue counts.
// The identity map the live accessor renders through is `hooks-identity.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, UltimateError } from '@ultimat3/core';
import { LiveClient } from './client';
import { makeCursor } from './cursor';
import {
  clearLiveClient,
  hasLiveClient,
  setLiveClient,
  useConnection,
  useLive,
  useMutation,
  useMutationQueue,
} from './hooks';
import {
  bumpRef,
  FakeSocket,
  flush,
  harness,
  likePost,
  liveFeed,
  type PostRow,
  querySid,
  sentMutateKey,
  signal,
  type Tables,
} from './hooks-fixture';
import { PROTOCOL_VERSION } from './sync-protocol';

/**
 * `useMutationQueue().pending`/`.failed` recompute from the queue on every read, so calling them
 * before and after a change proves nothing about whether the invalidation signal actually bumped —
 * the queue's own array is already correct either way, wired or not. Wrapping `onQueueChange` to
 * count firings directly is the only way to prove the automatic paths (a reconnect drain, an async
 * ack/fail frame) reach `hooks.ts` with no direct call driving them.
 */
function countNotifications(client: LiveClient<Tables>): () => number {
  let count = 0;
  const register = client.onQueueChange.bind(client);
  client.onQueueChange = (listener: () => void) =>
    register(() => {
      count += 1;
      listener();
    });
  return () => count;
}

/** Asserting on the code, not the message: the code is the part that is stable forever. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not an UltimateError: ${String(error)}`;
  }
  return 'nothing was thrown';
}

beforeEach(() => {
  clearLiveClient();
});

/**
 * Bun's test process has no DOM, so a BROWSER is what has to be faked, never a server — the same
 * shape `@ultimat3/ui`'s `solid-adapter.test.ts` uses, because the rule under test is the same
 * one: a missing registration means two different things on the two sides of that probe.
 */
function withDom<T>(fn: () => T): T {
  Object.assign(globalThis, { document: {}, window: {} });
  try {
    return fn();
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
  }
}

describe('the ambient client', () => {
  test('every hook names itself in X_LIVE_CLIENT_MISSING before registration, IN A BROWSER', () => {
    withDom(() => {
      expect(hasLiveClient()).toBe(false);
      expect(codeOf(() => useLive(liveFeed, null))).toBe('X_LIVE_CLIENT_MISSING');
      expect(codeOf(() => useConnection())).toBe('X_LIVE_CLIENT_MISSING');
      expect(codeOf(() => useMutation(likePost))).toBe('X_LIVE_CLIENT_MISSING');
      expect(codeOf(() => useMutationQueue())).toBe('X_LIVE_CLIENT_MISSING');
    });
  });

  /**
   * The other side of that probe, and the whole of issue #271: a page whose body reads a live
   * query answered 500 on its first request, because no server render can register a socket
   * client. It renders now — and renders its LOADING branch, which is what hydration replaces.
   */
  test('a server render gets a client instead of a throw, and it says loading', () => {
    expect(hasLiveClient()).toBe(false);
    const feed = useLive(liveFeed, null);
    expect(feed()).toEqual([]);
    expect(feed.state()).toBe('loading');
    expect(feed.cursor()).toBeNull();
    // Not `offline`: a banner about this visitor's connectivity, server-rendered into a document
    // being delivered to them, would flash on every page and vanish on hydrate.
    expect(useConnection().offline).toBe(false);
    expect(useConnection().updateAvailable).toBeNull();
    expect(useMutation(likePost).pending).toBe(0);
    expect(useMutationQueue().pending).toBe(0);
    expect(useMutationQueue().failed).toBe(0);
  });

  test('and it stays absent from hasLiveClient(), so a static fallback still knows', () => {
    useConnection();
    expect(hasLiveClient()).toBe(false);
  });

  /** Unsubscribing a subscription that was never opened is a teardown, never a refusal. */
  test('a server render can dispose the handle it was given', () => {
    const feed = useLive(liveFeed, null);
    expect(() => feed.unsubscribe()).not.toThrow();
    expect(() => feed[Symbol.dispose]()).not.toThrow();
  });

  test('a write during a server render is refused, never queued and never dropped', async () => {
    const mutate = useMutation(likePost);
    expect(
      await mutate({ postId: 'p1' }).then(
        () => 'resolved',
        (error: unknown) => (error instanceof UltimateError ? error.code : String(error)),
      ),
    ).toBe('X_LIVE_SERVER_RENDER');
  });

  test('registration is a toggle, so a test case never inherits the previous one', async () => {
    const { client } = await harness();
    setLiveClient(client);
    expect(hasLiveClient()).toBe(true);
    clearLiveClient();
    expect(hasLiveClient()).toBe(false);
  });
});

describe('useLive', () => {
  test('the accessor is the rows and the handle at once, and a patch reaches it', async () => {
    const { client, socket } = await harness();
    client.connect();
    socket.open();
    setLiveClient(client);

    const feed = useLive<PostRow>(liveFeed, () => ({ orgId: 'org-1' }));
    expect(feed()).toEqual([]);
    expect(feed.state()).toBe('loading');

    const sid = querySid(socket, 'add');
    const rows: readonly PostRow[] = [{ id: 'p1', likedByMe: false, likeCount: 2 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows,
      cursor: makeCursor('liveFeed', '0'.repeat(24), rows, 1_000),
    });
    expect(feed()).toEqual(rows);
    expect(feed.state()).toBe('live');
    expect(feed.cursor()?.count).toBe(1);

    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: '1'.repeat(24),
      patches: [{ op: 'update', id: 'p1', row: { likeCount: 3 }, lsn: '1'.repeat(24) }],
    });
    expect(feed().map((post) => post.likeCount)).toEqual([3]);
  });

  test('unsubscribe deregisters, so a later patch for that sid lands nowhere', async () => {
    const { client, socket } = await harness();
    client.connect();
    socket.open();
    setLiveClient(client);

    const feed = useLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const sid = querySid(socket, 'add');
    feed.unsubscribe();

    expect(querySid(socket, 'drop')).toBe(sid);
    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: '2'.repeat(24),
      patches: [{ op: 'insert', id: 'p9', row: { id: 'p9' }, lsn: '2'.repeat(24) }],
    });
    expect(feed()).toEqual([]);
  });

  test('a thunk input is read once — tier 3 has no runtime to re-run it', async () => {
    const { client, socket } = await harness();
    client.connect();
    socket.open();
    setLiveClient(client);

    let reads = 0;
    const feed = useLive(liveFeed, () => {
      reads += 1;
      return { orgId: 'org-1' };
    });
    feed();
    feed();
    expect(reads).toBe(1);
  });
});

describe('useConnection', () => {
  test('offline flips with the socket, because the members are getters over a signal', async () => {
    const { client, socket } = await harness();
    setLiveClient(client);
    const connection = useConnection();

    expect(connection.offline).toBe(true);
    expect(connection.online).toBe(false);

    client.connect();
    socket.open();
    expect(connection.offline).toBe(false);
    expect(connection.online).toBe(true);
    expect(connection.reconnectAt).toBeNull();

    socket.close();
    expect(connection.offline).toBe(true);
    expect(connection.reconnectAt).not.toBeNull();
  });

  test('updateAvailable carries the buildId the server announced', async () => {
    const { client, socket } = await harness();
    client.connect();
    socket.open();
    setLiveClient(client);
    const connection = useConnection();

    expect(connection.updateAvailable).toBeNull();
    socket.deliver({ type: 'update-available', v: PROTOCOL_VERSION, buildId: 'build-2' });
    expect(connection.updateAvailable).toBe('build-2');
  });
});

describe('useMutation', () => {
  test('applies the local twin, queues it while offline, and clears on the ack', async () => {
    const { client, socket, store, queue } = await harness();
    setLiveClient(client);
    const like = useMutation(likePost);

    await like({ postId: 'p1' });
    expect(store.tx.posts.get('p1')).toEqual({ id: 'p1', likedByMe: true, likeCount: 3 });
    expect(like.pending).toBe(1);
    expect(queue.pending()).toHaveLength(1);

    client.connect();
    socket.open();
    await useMutationQueue().drain();

    // Sent, not settled. `WebSocket.send` returning proves the frame reached a socket and nothing
    // else — a CLOSING one discards it silently — so the server is what empties the queue.
    expect(socket.frames().some((frame) => frame.type === 'mutate')).toBe(true);
    expect(like.pending).toBe(1);

    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: sentMutateKey(socket),
      lsn: '1'.repeat(24),
      error: null,
    });
    await flush();
    expect(like.pending).toBe(0);
  });

  test('a repeated idempotency key applies the optimistic twin once, not twice', async () => {
    const { client, store, queue } = await harness();
    setLiveClient(client);

    await client.mutate(bumpRef, { postId: 'p1' }, 'bump:p1');
    await client.mutate(bumpRef, { postId: 'p1' }, 'bump:p1');

    // One intent: the queue collapses it, so the twin must not run a second time over its own
    // result — 22 is the double count, and the journal a rollback replays is the second run's.
    expect(store.tx.posts.get('p1')?.likeCount).toBe(12);
    expect(queue.size).toBe(1);
    expect(queue.collapsed).toBe(1);
    expect(queue.pending()).toHaveLength(1);
  });

  test('pending counts this mutator only', async () => {
    const { client } = await harness();
    setLiveClient(client);
    const like = useMutation(likePost);
    const unrelated = useMutation({ name: 'archivePost' });

    await like({ postId: 'p1' });
    expect(like.pending).toBe(1);
    expect(unrelated.pending).toBe(0);
  });

  test('tier 2 has no queue, so pending is 0 rather than a guess', async () => {
    const socket = new FakeSocket();
    const client = new LiveClient({
      signal,
      connect: () => socket,
      buildId: 'build-1',
      clock: frozenClock(1_000),
    });
    client.connect();
    socket.open();
    setLiveClient(client);

    const like = useMutation({ name: 'likePost' });
    await like({ postId: 'p1' });
    expect(like.pending).toBe(0);
    expect(useMutationQueue().pending).toBe(0);
  });
});

describe('useMutationQueue', () => {
  test('the counts are the queue, read through the invalidation signal', async () => {
    const { client, queue } = await harness();
    setLiveClient(client);
    const like = useMutation(likePost);
    const view = useMutationQueue();

    expect(view.pending).toBe(0);
    await like({ postId: 'p1' });
    await like({ postId: 'p2' });
    expect(view.pending).toBe(queue.pending().length);
    expect(view.pending).toBe(2);
    expect(view.failed).toBe(0);

    const first = queue.pending()[0];
    await queue.fail(first?.key ?? '', { code: 'X_FORBIDDEN', cause: 'denied', fix: 'x doctor' });
    expect(view.failed).toBe(1);
    expect(view.pending).toBe(1);
  });

  // The gap this closes: `connect()`'s `onOpen` handler drains automatically on every reconnect,
  // entirely inside `client.ts` — no hook awaits that call, so nothing bumped the invalidation
  // signal for it before `LiveClient.onQueueChange` existed.
  test('an automatic reconnect drain notifies the queue view with no direct hook call', async () => {
    const { client, socket, queue } = await harness();
    const notifications = countNotifications(client);
    setLiveClient(client);

    client.connect();
    socket.open(); // first connect: queue is empty, the automatic drain is a no-op
    await flush();
    socket.close(); // drop the connection

    const like = useMutation(likePost);
    await like({ postId: 'p1' }); // queued while offline; mutate()'s own drain() no-ops offline
    expect(queue.pending()).toHaveLength(1);
    const beforeReconnect = notifications();

    client.connect(); // the reconnect, called directly: the timer that arms it is `client.test.ts`
    socket.open();
    await flush();

    // Sent by the reconnect drain, and still queued: only the server's ack retires it.
    const key = sentMutateKey(socket);
    expect(key).not.toBe('');
    expect(queue.pending()).toHaveLength(1);
    expect(notifications()).toBeGreaterThan(beforeReconnect); // ...and the listener fired for it

    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: key, lsn: null, error: null });
    await flush();
    expect(queue.pending()).toHaveLength(0);
    expect(useMutationQueue().pending).toBe(0); // the hook's own getter agrees
  });

  // A listener per registration, kept forever: the client outlives `setLiveClient`, so the
  // unsubscribe it returns is the only thing that can drop the previous one.
  test('re-registering a client replaces its queue listener instead of stacking one', async () => {
    const { client, socket } = await harness();
    const notifications = countNotifications(client);
    setLiveClient(client);
    setLiveClient(client);
    setLiveClient(client);

    client.connect();
    socket.open();
    await flush(); // the automatic drain notifies exactly once

    expect(notifications()).toBe(1);
  });

  // The gap this closes: a server ack/nack arrives asynchronously on `#onFrame`, entirely inside
  // `client.ts` — no hook awaits that frame either, so a delayed failure went unnoticed the same
  // way a reconnect drain did.
  test('a socket-delivered failed ack notifies the queue view with no direct hook call', async () => {
    const { client, socket, queue } = await harness();
    const notifications = countNotifications(client);
    setLiveClient(client);
    client.connect();
    socket.open();

    const like = useMutation(likePost);
    await like({ postId: 'p1' }); // connected: mutate()'s own drain() sends it immediately
    const key = sentMutateKey(socket);
    expect(key).not.toBe('');
    const beforeAck = notifications();

    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: key,
      lsn: null,
      error: { code: 'X_FORBIDDEN', cause: 'denied by policy', fix: 'x doctor' },
    });
    await flush();

    expect(notifications()).toBeGreaterThan(beforeAck);
    expect(useMutationQueue().failed).toBe(1);
    expect(queue.all().find((mutation) => mutation.key === key)?.status).toBe('failed');
  });
});
