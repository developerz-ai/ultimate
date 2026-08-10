// The hooks are the whole surface an app component sees, so this covers the seam rather than the
// client underneath it: the ambient registration and the error when it is missing, the callable
// live accessor, the connection getters that have to stay live, and the two queue counts.
// Signals are two closures — no solid-js in the test either, for the same reason as in the source.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, UltimateError } from '@ultimat3/core';
import { type ClientSocket, LiveClient, type SignalFactory } from './client';
import { makeCursor } from './cursor';
import {
  clearLiveClient,
  hasLiveClient,
  type MutatorLike,
  setLiveClient,
  useConnection,
  useLive,
  useMutation,
  useMutationQueue,
} from './hooks';
import type { Row } from './json';
import { type LocalTx, MemoryLocalStore } from './local-store';
import { MemoryQueueStore, OfflineQueue } from './offline-queue';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

type PostRow = Row & { readonly likedByMe: boolean; readonly likeCount: number };
type Tables = { posts: PostRow };

/** Synchronous and closure-backed: enough to prove an accessor re-reads, with no reactive runtime. */
const signal: SignalFactory = <T>(initial: T) => {
  let value = initial;
  return [
    () => value,
    (next: T) => {
      value = next;
    },
  ];
};

/** The injected socket, driven from the test: `open`/`deliver` are the server's half. */
class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;
  #closed: ((code: number) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.#closed?.(code);
  }

  onOpen(handler: () => void): void {
    this.#open = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }

  onClose(handler: (code: number) => void): void {
    this.#closed = handler;
  }

  open(): void {
    this.#open?.();
  }

  deliver(frame: Frame): void {
    this.#message?.(encode(frame));
  }

  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

interface Harness {
  readonly client: LiveClient<Tables>;
  readonly socket: FakeSocket;
  readonly store: MemoryLocalStore<Tables>;
  readonly queue: OfflineQueue;
}

/** Tier 3 by default — the queue is what most of these cases are about. */
async function harness(): Promise<Harness> {
  const socket = new FakeSocket();
  const store = new MemoryLocalStore<Tables>({
    posts: [{ id: 'p1', likedByMe: false, likeCount: 2 }],
  });
  const queue = await OfflineQueue.open(new MemoryQueueStore());
  const client = new LiveClient<Tables>({
    signal,
    connect: () => socket,
    buildId: 'build-1',
    store,
    queue,
    clock: frozenClock(1_000),
    rng: () => 0,
  });
  return { client, socket, store, queue };
}

/** The sid the client minted for its query subscription — the test never picks one. */
function querySid(socket: FakeSocket, op: 'add' | 'drop'): string {
  for (const frame of socket.frames()) {
    if (frame.type === 'subscribe' && frame.op === op && frame.target.kind === 'query') {
      return frame.sid;
    }
  }
  return '';
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

const liveFeed = { name: 'liveFeed' };

/**
 * Narrower than `MutatorLike` on both parameters, which is the point: this is the shape
 * `@ultimat3/action`'s `mutator()` produces, and it has to assign with no cast at the call site.
 */
const likePost = {
  name: 'likePost',
  local(tx: LocalTx<Tables>, input: { readonly postId: string }): void {
    tx.posts.update(input.postId, (post) =>
      post.likedByMe ? {} : { likedByMe: true, likeCount: post.likeCount + 1 },
    );
  },
} satisfies MutatorLike;

beforeEach(() => {
  clearLiveClient();
});

describe('the ambient client', () => {
  test('every hook names itself in X_LIVE_CLIENT_MISSING before registration', () => {
    expect(hasLiveClient()).toBe(false);
    expect(codeOf(() => useLive(liveFeed, null))).toBe('X_LIVE_CLIENT_MISSING');
    expect(codeOf(() => useConnection())).toBe('X_LIVE_CLIENT_MISSING');
    expect(codeOf(() => useMutation(likePost))).toBe('X_LIVE_CLIENT_MISSING');
    expect(codeOf(() => useMutationQueue())).toBe('X_LIVE_CLIENT_MISSING');
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
  test('applies the local twin, queues it while offline, and clears on drain', async () => {
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

    expect(like.pending).toBe(0);
    expect(socket.frames().some((frame) => frame.type === 'mutate')).toBe(true);
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
});
